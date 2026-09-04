#!/usr/bin/env node
'use strict';

/**
 * Construit le scénario Make A (vérification quotidienne) via l'API Make :
 * Airtable Search Records (Domaines, Actif=true) → HTTP vérification
 * certificat → HTTP RDAP → calcul des jours restants → mise à jour
 * Airtable. Ne construit PAS encore la branche d'alerte (router, filtre
 * anti-doublon, envoi email/Slack/SMS) — voir la note en bas de ce fichier.
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
    {
      id: 4,
      module: 'util:SetVariable2',
      version: 1,
      parameters: {},
      mapper: {
        name: 'jours_restants_cert',
        scope: 'roundtrip',
        // Make auto-parse les dates ISO renvoyées par un module HTTP avec
        // "Parse response" activé, mais parseDate() explicite lève toute
        // ambiguïté. La soustraction de deux dates donne des millisecondes.
        value: '{{round((parseDate(2.data.expires_at) - now) / 86400000)}}',
      },
      metadata: { designer: { x: 900, y: 0 } },
    },
    {
      id: 5,
      module: 'util:SetVariable2',
      version: 1,
      parameters: {},
      mapper: {
        name: 'date_expiration_domaine',
        scope: 'roundtrip',
        // map(collection; sortie; clé_filtre; valeur_filtre) : fonction Make
        // publique (documentée), pas un module caché — évite d'avoir à
        // vérifier un module Itérateur séparé. "events" n'a pas d'ordre
        // garanti selon le registre RDAP ; ceci cherche la bonne entrée
        // plutôt que de supposer un index fixe.
        value: '{{get(map(3.data.events; "eventDate"; "eventAction"; "expiration"); 1)}}',
      },
      metadata: { designer: { x: 1200, y: 0 } },
    },
    {
      id: 6,
      module: 'util:SetVariable2',
      version: 1,
      parameters: {},
      mapper: {
        name: 'jours_restants_domaine',
        scope: 'roundtrip',
        value: '{{round((parseDate(5.`date_expiration_domaine`) - now) / 86400000)}}',
      },
      metadata: { designer: { x: 1500, y: 0 } },
    },
    {
      id: 7,
      module: 'airtable:ActionUpdateRecords',
      version: 3,
      parameters: { __IMTCONN__: Number(AIRTABLE_CONNECTION_ID) },
      mapper: {
        id: '{{1.id}}',
        base: BASE_ID,
        table: domaines.id,
        record: {
          // IMPORTANT : "record" est TOUJOURS keyé par ID de champ
          // (fldXXXXXXXXXXXXXX), jamais par nom, même avec useColumnId:
          // false — confirmé en inspectant un module Update configuré à la
          // main. Voir scripts/README.md.
          [domaines.fields['Statut certificat']]:
            '{{if(2.data.error; "erreur"; if(4.jours_restants_cert <= 7; "urgent"; if(4.jours_restants_cert <= 30; "à surveiller"; "valide")))}}',
          [domaines.fields['Date expiration certificat']]: '{{formatDate(parseDate(2.data.expires_at); "YYYY-MM-DD")}}',
          [domaines.fields['Émetteur certificat']]: '{{2.data.issuer}}',
          [domaines.fields['Statut domaine']]:
            // "!=" et non "<>" — "<>" échoue au parsing IML avec
            // "Operator next to operator" (confirmé en le testant).
            '{{if(3.statusCode != 200; "erreur"; if(6.jours_restants_domaine <= 7; "urgent"; if(6.jours_restants_domaine <= 30; "à surveiller"; "valide")))}}',
          [domaines.fields['Date expiration domaine']]: '{{formatDate(parseDate(5.`date_expiration_domaine`); "YYYY-MM-DD")}}',
          [domaines.fields['Dernière vérification']]: '{{now}}',
          [domaines.fields['Dernière erreur']]: '{{2.data.error}}',
        },
        typecast: false,
        useColumnId: false,
      },
      metadata: { designer: { x: 1800, y: 0 } },
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
 *   Un router (module "builtin:BasicRouter") à branches par seuil
 *   (jours_restants <= 30/14/7/1, opérateur "number:lessorequal" —
 *   structure et opérateur déjà vérifiés, voir scripts/README.md), chaque
 *   branche avec une recherche Airtable anti-doublon dans Alertes, un envoi
 *   (email / Slack / SMS — identifiants de modules pas encore vérifiés) et
 *   un "airtable:ActionCreateRecord" dans Alertes.
 */
