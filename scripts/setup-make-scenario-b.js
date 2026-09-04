#!/usr/bin/env node
'use strict';

/**
 * Construit le scénario Make B (ajout d'un domaine, déclenché par webhook)
 * via l'API Make : Webhook reçoit {compte_id, nom_domaine, client_final_id?}
 * → recherche le compte et compte ses domaines existants → si sous quota,
 * crée le domaine, lance immédiatement la vérification (certificat + RDAP,
 * même logique que le scénario A) et répond succès ; sinon répond erreur
 * quota_atteint. Voir docs/cahier-des-charges-technique.md section 2.B.
 *
 * Découvertes propres à ce scénario (webhook), en plus de celles de
 * scripts/README.md :
 *   - Modules : "gateway:CustomWebHook" (déclencheur) et
 *     "gateway:WebhookRespond" (réponse). Le hook lui-même est une
 *     ressource séparée créée via POST /api/v2/hooks (scope "hooks:write"),
 *     référencée par son id numérique dans parameters.hook du déclencheur.
 *   - Un webhook JSON expose ses clés directement à plat sur le bundle
 *     (`{{1.compte_id}}`), pas besoin de descendre dans un sous-objet —
 *     confirmé en envoyant une vraie requête de test et en inspectant le
 *     bundle capturé.
 *   - Pas d'opérateur ">=" vérifié (seulement "number:lessorequal", voir
 *     scripts/README.md) : la vérification de quota compare donc dans les
 *     deux sens avec le même opérateur — route "autorisé" :
 *     compte <= quota-1 ; route "quota atteint" : quota <= compte
 *     (équivalents et complémentaires pour des entiers).
 *   - Comptage des domaines existants via l'agrégateur COUNT : imprécis à 0
 *     résultat réel (retourne 1 au lieu de 0, voir le bug documenté dans
 *     scripts/README.md) mais sans conséquence ici puisque les quotas
 *     réels sont toujours >= 1 — seul le cas quota=1 serait affecté, non
 *     représenté dans les offres actuelles (Essentiel = 10 domaines).
 *
 * Usage :
 *   MAKE_TOKEN=... MAKE_TEAM_ID=... MAKE_ZONE=eu1.make.com \
 *   AIRTABLE_CONNECTION_ID=... VIGIE_API_KEY=... \
 *   node scripts/setup-make-scenario-b.js
 *
 * Non idempotent : relancer crée un nouveau scénario ET un nouveau webhook
 * à chaque fois.
 */

const TOKEN = process.env.MAKE_TOKEN;
const TEAM_ID = process.env.MAKE_TEAM_ID;
const ZONE = process.env.MAKE_ZONE || 'eu1.make.com';
const AIRTABLE_CONNECTION_ID = process.env.AIRTABLE_CONNECTION_ID;
const VIGIE_API_KEY = process.env.VIGIE_API_KEY;

if (!TOKEN || !TEAM_ID || !AIRTABLE_CONNECTION_ID || !VIGIE_API_KEY) {
  console.error(
    'Usage : MAKE_TOKEN=... MAKE_TEAM_ID=... AIRTABLE_CONNECTION_ID=... VIGIE_API_KEY=... node scripts/setup-make-scenario-b.js',
  );
  process.exit(1);
}

const airtableSchema = require('./airtable-schema.json');
const BASE_ID = 'apptozA0MNHsGlSNw';
const comptes = airtableSchema.Comptes;
const domaines = airtableSchema.Domaines;

const domainRef = '{{1.nom_domaine}}';

async function main() {
  console.log("Création du webhook 'vigie-ajout-domaine'...");
  const hookRes = await fetch(`https://${ZONE}/api/v2/hooks`, {
    method: 'POST',
    headers: { Authorization: `Token ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'vigie-ajout-domaine',
      teamId: Number(TEAM_ID),
      typeName: 'gateway-webhook',
      headers: false,
      method: false,
      stringify: false,
    }),
  });
  const hookJson = await hookRes.json();
  if (!hookRes.ok) {
    console.error('Échec création webhook :', JSON.stringify(hookJson, null, 2));
    process.exit(1);
  }
  const hook = hookJson.hook;
  console.log(`Webhook créé : ${hook.id} — URL : ${hook.url}`);

  const blueprint = {
    name: 'Vigie — B. Ajout de domaine',
    flow: [
      {
        id: 1,
        module: 'gateway:CustomWebHook',
        version: 1,
        parameters: { hook: hook.id, maxResults: 1 },
        mapper: {},
        metadata: { designer: { x: 0, y: 0 } },
      },
      {
        id: 2,
        module: 'airtable:ActionSearchRecords',
        version: 3,
        parameters: { __IMTCONN__: Number(AIRTABLE_CONNECTION_ID) },
        mapper: {
          base: BASE_ID,
          table: comptes.id,
          useColumnId: false,
          formula: `RECORD_ID() = "{{1.compte_id}}"`,
          maxRecords: '1',
        },
        metadata: { designer: { x: 300, y: 0 } },
      },
      {
        id: 3,
        module: 'airtable:ActionSearchRecords',
        version: 3,
        parameters: { __IMTCONN__: Number(AIRTABLE_CONNECTION_ID) },
        mapper: {
          base: BASE_ID,
          table: domaines.id,
          useColumnId: false,
          // Comparer par NOM (pas par ID) — ARRAYJOIN sur un champ de
          // liaison renvoie le nom de l'enregistrement lié. Voir
          // scripts/README.md, section "Envoi email et anti-doublon".
          formula: 'FIND("{{2.`Nom du compte`}}", ARRAYJOIN({Compte}))',
          maxRecords: '200',
        },
        metadata: { designer: { x: 600, y: 0 } },
      },
      {
        id: 4,
        module: 'util:FunctionAggregator2',
        version: 1,
        parameters: { fn: 'count', feeder: 3 },
        mapper: { value: '' },
        metadata: { designer: { x: 900, y: 0 } },
      },
      {
        id: 10,
        mapper: null,
        module: 'builtin:BasicRouter',
        version: 1,
        routes: [
          {
            // Route "autorisé" : nb domaines actuels <= quota - 1.
            flow: [
              {
                id: 11,
                module: 'airtable:ActionCreateRecord',
                version: 3,
                parameters: { __IMTCONN__: Number(AIRTABLE_CONNECTION_ID) },
                filter: {
                  name: 'sous-quota',
                  conditions: [[{ a: '{{4.result}}', b: `{{2.\`Quota domaines\` - 1}}`, o: 'number:lessorequal' }]],
                },
                mapper: {
                  base: BASE_ID,
                  table: domaines.id,
                  record: {
                    [domaines.fields['Nom de domaine']]: domainRef,
                    [domaines.fields['Compte']]: ['{{1.compte_id}}'],
                    [domaines.fields['Actif']]: true,
                  },
                  typecast: false,
                  useColumnId: false,
                },
                metadata: { designer: { x: 1200, y: -150 } },
              },
              {
                id: 12,
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
                metadata: { designer: { x: 1500, y: -150 } },
              },
              {
                id: 13,
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
                metadata: { designer: { x: 1800, y: -150 } },
              },
              {
                id: 14,
                module: 'util:SetVariable2',
                version: 1,
                parameters: {},
                mapper: {
                  name: 'jours_restants_cert',
                  scope: 'roundtrip',
                  value: '{{round((parseDate(12.data.expires_at) - now) / 86400000)}}',
                },
                metadata: { designer: { x: 2100, y: -150 } },
              },
              {
                id: 15,
                module: 'util:SetVariable2',
                version: 1,
                parameters: {},
                mapper: {
                  name: 'date_expiration_domaine',
                  scope: 'roundtrip',
                  value: '{{get(map(13.data.events; "eventDate"; "eventAction"; "expiration"); 1)}}',
                },
                metadata: { designer: { x: 2400, y: -150 } },
              },
              {
                id: 16,
                module: 'util:SetVariable2',
                version: 1,
                parameters: {},
                mapper: {
                  name: 'jours_restants_domaine',
                  scope: 'roundtrip',
                  value: '{{round((parseDate(15.`date_expiration_domaine`) - now) / 86400000)}}',
                },
                metadata: { designer: { x: 2700, y: -150 } },
              },
              {
                id: 17,
                module: 'airtable:ActionUpdateRecords',
                version: 3,
                parameters: { __IMTCONN__: Number(AIRTABLE_CONNECTION_ID) },
                mapper: {
                  id: '{{11.id}}',
                  base: BASE_ID,
                  table: domaines.id,
                  record: {
                    [domaines.fields['Statut certificat']]:
                      '{{if(12.data.error; "erreur"; if(14.jours_restants_cert <= 7; "urgent"; if(14.jours_restants_cert <= 30; "à surveiller"; "valide")))}}',
                    [domaines.fields['Date expiration certificat']]: '{{formatDate(parseDate(12.data.expires_at); "YYYY-MM-DD")}}',
                    [domaines.fields['Émetteur certificat']]: '{{12.data.issuer}}',
                    [domaines.fields['Statut domaine']]:
                      '{{if(13.statusCode != 200; "erreur"; if(16.jours_restants_domaine <= 7; "urgent"; if(16.jours_restants_domaine <= 30; "à surveiller"; "valide")))}}',
                    [domaines.fields['Date expiration domaine']]: '{{formatDate(parseDate(15.`date_expiration_domaine`); "YYYY-MM-DD")}}',
                    [domaines.fields['Dernière vérification']]: '{{now}}',
                    [domaines.fields['Dernière erreur']]: '{{12.data.error}}',
                  },
                  typecast: false,
                  useColumnId: false,
                },
                metadata: { designer: { x: 3000, y: -150 } },
              },
              {
                id: 18,
                module: 'gateway:WebhookRespond',
                version: 1,
                parameters: {},
                mapper: {
                  status: '200',
                  body: '{"ok": true, "domaine_id": "{{11.id}}"}',
                  headers: [],
                },
                metadata: { designer: { x: 3300, y: -150 } },
              },
            ],
          },
          {
            // Route "quota atteint" : quota <= nb domaines actuels.
            flow: [
              {
                id: 21,
                module: 'gateway:WebhookRespond',
                version: 1,
                parameters: {},
                filter: {
                  name: 'quota-atteint',
                  conditions: [[{ a: '{{2.`Quota domaines`}}', b: '{{4.result}}', o: 'number:lessorequal' }]],
                },
                mapper: {
                  status: '200',
                  body: '{"ok": false, "error": "quota_atteint", "message": "Quota de domaines atteint pour ce compte."}',
                  headers: [],
                },
                metadata: { designer: { x: 1200, y: 150 } },
              },
            ],
          },
        ],
        metadata: { designer: { x: 900, y: 0 } },
      },
    ],
    metadata: {
      instant: true,
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

  console.log('Création du scénario...');
  const res = await fetch(`https://${ZONE}/api/v2/scenarios`, {
    method: 'POST',
    headers: { Authorization: `Token ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: Number(TEAM_ID), blueprint: JSON.stringify(blueprint), scheduling: JSON.stringify({ type: 'immediately' }) }),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error('Échec :', JSON.stringify(json, null, 2));
    process.exit(1);
  }
  console.log('Créé, scénario', json.scenario.id, '— pas activé, webhook URL :', hook.url);
}

main();

/**
 * SIMPLIFICATIONS ASSUMÉES (à affiner plus tard) :
 *   - "Client final" (client_final_id) n'est pas encore câblé sur la
 *     création — un champ de liaison optionnel construit dynamiquement en
 *     IML est plus délicat à fiabiliser sans vérification dédiée ; à
 *     ajouter en suivant la même méthode (construire l'exemple à la main,
 *     lire sa blueprint) si besoin.
 *   - Pas de garde-fou si `1.compte_id` ne correspond à aucun compte réel
 *     (recherche 2 vide) — la suite planterait proprement (erreur Airtable
 *     sur un update sans "id" valide) plutôt que de répondre une erreur
 *     propre au webhook. À durcir avant mise en prod publique.
 */
