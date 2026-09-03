#!/usr/bin/env node
'use strict';

/**
 * Construit le cœur du scénario Make A (vérification quotidienne) via
 * l'API Make : Airtable Search Records (Domaines, Actif=true) → HTTP
 * vérification certificat → HTTP RDAP. Ne construit PAS encore la branche
 * d'alerte (router, filtre anti-doublon, mise à jour Airtable, envoi
 * email/Slack/SMS) — voir la note en bas de ce fichier.
 *
 * Les identifiants de modules ci-dessous (airtable:ActionSearchRecords,
 * http:MakeRequest, etc.) ne sont documentés nulle part publiquement de
 * façon fiable : ils ont été découverts en faisant construire un scénario
 * jetable à la main dans l'interface Make, puis en lisant sa blueprint via
 * GET /scenarios/{id}/blueprint. Voir scripts/README.md pour le détail des
 * découvertes (notamment le piège des noms de champs avec espaces).
 *
 * Usage :
 *   MAKE_TOKEN=... MAKE_TEAM_ID=... MAKE_ZONE=eu1.make.com \
 *   AIRTABLE_CONNECTION_ID=... VIGIE_API_KEY=... \
 *   node scripts/setup-make-scenario-a.js
 *
 * Non idempotent (comme setup-airtable-base.js) : relancer crée un nouveau
 * scénario à chaque fois.
 */

const TOKEN = process.env.MAKE_TOKEN;
const TEAM_ID = process.env.MAKE_TEAM_ID;
const ZONE = process.env.MAKE_ZONE || 'eu1.make.com';
const AIRTABLE_CONNECTION_ID = process.env.AIRTABLE_CONNECTION_ID;
const VIGIE_API_KEY = process.env.VIGIE_API_KEY;

if (!TOKEN || !TEAM_ID || !AIRTABLE_CONNECTION_ID || !VIGIE_API_KEY) {
  console.error(
    'Usage : MAKE_TOKEN=... MAKE_TEAM_ID=... AIRTABLE_CONNECTION_ID=... VIGIE_API_KEY=... node scripts/setup-make-scenario-a.js',
  );
  process.exit(1);
}

const airtableSchema = require('./airtable-schema.json');
const BASE_ID = 'apptozA0MNHsGlSNw';
const domaines = airtableSchema.Domaines;

// IMPORTANT : une référence à un champ Airtable dont le nom contient un
// espace (ex. "Nom de domaine") DOIT être entourée de backticks dans une
// expression Make — {{1.Nom de domaine}} se résout en chaîne VIDE sans
// erreur visible, {{1.`Nom de domaine`}} fonctionne. Découvert en testant
// une exécution réelle : le module HTTP recevait un paramètre "domain"
// vide malgré un mapping qui semblait correct dans l'éditeur visuel.
const domainRef = '{{1.`Nom de domaine`}}';

const blueprint = {
  name: 'Vigie — A. Vérification quotidienne',
  flow: [
    {
      id: 1,
      module: 'airtable:ActionSearchRecords',
      version: 3,
      parameters: { __IMTCONN__: Number(AIRTABLE_CONNECTION_ID) },
      mapper: {
        base: BASE_ID,
        table: domaines.id,
        useColumnId: false,
        formula: '{Actif} = TRUE()',
        sort: [{ field: domaines.fields['Date expiration certificat'], direction: 'asc' }],
      },
      metadata: { designer: { x: 0, y: 0 } },
    },
    {
      id: 2,
      module: 'http:MakeRequest',
      version: 4,
      parameters: { tlsType: '', authenticationType: 'noAuth' },
      mapper: {
        url: 'https://serverless-two-tau.vercel.app/api/cert',
        method: 'get',
        headers: [{ name: 'X-Vigie-Key', value: VIGIE_API_KEY }],
        queryParameters: [{ name: 'domain', value: domainRef }],
        shareCookies: false,
        parseResponse: true,
        allowRedirects: true,
        stopOnHttpError: false,
        requestCompressedContent: true,
      },
      metadata: { designer: { x: 300, y: 0 } },
    },
    {
      id: 3,
      module: 'http:MakeRequest',
      version: 4,
      parameters: { tlsType: '', authenticationType: 'noAuth' },
      mapper: {
        url: `https://rdap.org/domain/${domainRef}`,
        method: 'get',
        headers: [
          { name: 'Accept', value: 'application/rdap+json' },
          { name: 'User-Agent', value: 'curl/8.21.0' },
        ],
        shareCookies: false,
        parseResponse: true,
        allowRedirects: true,
        stopOnHttpError: false,
        requestCompressedContent: true,
      },
      metadata: { designer: { x: 600, y: 0 } },
    },
  ],
  metadata: {
    instant: false,
    version: 1,
    designer: { orphans: [] },
    scenario: {
      roundtrips: 1,
      maxErrors: 3,
      autoCommit: true,
      autoCommitTriggerLast: true,
      sequential: false,
      confidential: false,
      dataloss: false,
      dlq: false,
    },
  },
};

// Planification "tous les jours à 06:00" — sous le capot, Make encode ça
// comme un déclencheur "indefinitely" (intervalle 15 min, valeur par
// défaut) restreint à une fenêtre d'1 minute par jour via "restrict".
// Découvert en réglant "Daily 06:00" dans l'UI puis en relisant le
// scénario via l'API — deviner "type: daily" aurait été faux.
const scheduling = {
  type: 'indefinitely',
  interval: 900,
  restrict: [{ days: [1, 2, 3, 4, 5, 6, 0], time: ['06:00', '06:01'] }],
};

async function main() {
  const res = await fetch(`https://${ZONE}/api/v2/scenarios`, {
    method: 'POST',
    headers: { Authorization: `Token ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: Number(TEAM_ID), blueprint: JSON.stringify(blueprint), scheduling: JSON.stringify(scheduling) }),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error('Échec :', JSON.stringify(json, null, 2));
    process.exit(1);
  }
  console.log('Créé, scénario', json.scenario.id, '— pas activé (isActive: false), à vérifier puis activer manuellement.');
}

main();

/**
 * CE QUI RESTE À CONSTRUIRE (pas encore fait) pour que le scénario A soit
 * complet, voir docs/cahier-des-charges-technique.md section 2.A :
 *   5. Set variable(s) : jours_restants_cert / jours_restants_domaine
 *      (soustraction de dates) — module "util:SetVariable2", confirmé
 *      fonctionner mais pas encore câblé ici.
 *   6. Airtable — Update Record sur Domaines (module
 *      "airtable:ActionUpdateRecords", mapper { id, base, table, record:
 *      { <fieldId>: value, ... }, typecast: false, useColumnId: false } —
 *      "record" est TOUJOURS keyé par ID de champ, jamais par nom, même
 *      avec useColumnId=false. Confirmé en inspectant un module configuré
 *      à la main).
 *   7. Router à deux branches (certificat / domaine), chacune avec un
 *      filtre sur le palier, une recherche Airtable anti-doublon dans
 *      Alertes, puis l'envoi (email / Slack / SMS) et un
 *      "airtable:ActionCreateRecord" dans Alertes. La structure exacte
 *      d'un router dans une blueprint Make (builtin:BasicRouter + routes
 *      imbriquées) n'a pas encore été vérifiée sur un exemple réel — à
 *      faire de la même façon que le reste de ce fichier avant de la
 *      construire par API, plutôt que de la deviner.
 */
