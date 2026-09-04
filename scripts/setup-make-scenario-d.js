#!/usr/bin/env node
'use strict';

/**
 * Construit le scénario Make D (synchronisation Stripe → Airtable) via
 * l'API Make : webhook générique (pas le module Stripe officiel — évite
 * d'avoir besoin d'une connexion OAuth Stripe, et fonctionne à l'identique
 * puisque Stripe POST un JSON standard) → recherche du Compte par
 * Stripe Customer ID → routeur par type d'événement → met à jour
 * `Statut abonnement`. Voir docs/cahier-des-charges-technique.md section
 * 2.D.
 *
 * Découvertes propres à ce scénario, en plus de celles de
 * scripts/README.md :
 *   - Un webhook Make préserve la structure JSON imbriquée telle quelle
 *     (pas d'aplatissement) : `{{1.data.object.customer}}` fonctionne
 *     directement pour un payload `{ data: { object: { customer: ... } } }`
 *     — confirmé en envoyant un payload imbriqué réel et en inspectant le
 *     bundle capturé.
 *   - `=` fonctionne comme opérateur d'égalité dans une expression IML
 *     (`{{if(1.type = "..."; ...)}}`) — confirmé par un test isolé. Seuls
 *     `!=` et les opérateurs de filtre (`number:lessorequal`, etc.)
 *     avaient été vérifiés jusque-là ce jour.
 *   - Un scénario déclenché par webhook sans module "Webhook response"
 *     répond automatiquement `Accepted` / HTTP 200 — suffisant pour
 *     Stripe, qui ne regarde que le code de statut.
 *
 * NON COUVERT — décision volontairement reportée : la mise à jour d'
 * `Offre` et `Quota domaines` à partir du prix Stripe (`data.object.items
 * .data[].price.id`) suppose une correspondance prix → offre qui n'existe
 * pas encore (aucun produit Stripe réel créé à ce jour). Seul
 * `Statut abonnement` est mis à jour, dérivé du champ `status` de Stripe
 * qui est stable et documenté publiquement.
 *
 * Usage :
 *   MAKE_TOKEN=... MAKE_TEAM_ID=... MAKE_ZONE=eu1.make.com \
 *   AIRTABLE_CONNECTION_ID=... node scripts/setup-make-scenario-d.js
 *
 * Non idempotent : relancer crée un nouveau scénario ET un nouveau webhook
 * à chaque fois.
 */

const TOKEN = process.env.MAKE_TOKEN;
const TEAM_ID = process.env.MAKE_TEAM_ID;
const ZONE = process.env.MAKE_ZONE || 'eu1.make.com';
const AIRTABLE_CONNECTION_ID = process.env.AIRTABLE_CONNECTION_ID;

if (!TOKEN || !TEAM_ID || !AIRTABLE_CONNECTION_ID) {
  console.error('Usage : MAKE_TOKEN=... MAKE_TEAM_ID=... AIRTABLE_CONNECTION_ID=... node scripts/setup-make-scenario-d.js');
  process.exit(1);
}

const airtableSchema = require('./airtable-schema.json');
const BASE_ID = 'apptozA0MNHsGlSNw';
const comptes = airtableSchema.Comptes;

// Mappe le statut d'abonnement Stripe vers nos statuts internes. "status"
// est un champ Stripe stable et documenté publiquement (contrairement aux
// ID de prix, propres à chaque compte Stripe).
const statutFormula =
  '{{if(1.data.object.status = "active"; "actif"; ' +
  'if(1.data.object.status = "trialing"; "essai"; ' +
  'if(1.data.object.status = "past_due"; "impayé"; ' +
  'if(1.data.object.status = "unpaid"; "impayé"; "annulé"))))}}';

function updateStatut(id, value, y) {
  return {
    id,
    module: 'airtable:ActionUpdateRecords',
    version: 3,
    parameters: { __IMTCONN__: Number(AIRTABLE_CONNECTION_ID) },
    mapper: {
      id: '{{2.id}}',
      base: BASE_ID,
      table: comptes.id,
      record: { [comptes.fields['Statut abonnement']]: value },
      typecast: false,
      useColumnId: false,
    },
    metadata: { designer: { x: 900, y } },
  };
}

async function main() {
  console.log("Création du webhook 'vigie-stripe-sync'...");
  const hookRes = await fetch(`https://${ZONE}/api/v2/hooks`, {
    method: 'POST',
    headers: { Authorization: `Token ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'vigie-stripe-sync',
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
  console.log('À coller dans Stripe (Developers → Webhooks → Add endpoint), événements :');
  console.log('  customer.subscription.created, customer.subscription.updated,');
  console.log('  customer.subscription.deleted, invoice.payment_failed');

  const blueprint = {
    name: 'Vigie — D. Synchronisation Stripe',
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
          formula: '{Stripe Customer ID} = "{{1.data.object.customer}}"',
          maxRecords: '1',
        },
        metadata: { designer: { x: 300, y: 0 } },
      },
      {
        id: 3,
        mapper: null,
        module: 'builtin:BasicRouter',
        version: 1,
        routes: [
          {
            // Abonnement créé ou mis à jour : statut dérivé de Stripe "status".
            flow: [
              {
                ...updateStatut(11, statutFormula, -200),
                filter: {
                  name: 'subscription-created-ou-updated',
                  conditions: [
                    [{ a: '{{1.type}}', b: 'customer.subscription.created', o: 'text:equal' }],
                    [{ a: '{{1.type}}', b: 'customer.subscription.updated', o: 'text:equal' }],
                  ],
                },
              },
            ],
          },
          {
            // Abonnement annulé.
            flow: [
              {
                ...updateStatut(21, 'annulé', 0),
                filter: {
                  name: 'subscription-deleted',
                  conditions: [[{ a: '{{1.type}}', b: 'customer.subscription.deleted', o: 'text:equal' }]],
                },
              },
            ],
          },
          {
            // Paiement échoué.
            flow: [
              {
                ...updateStatut(31, 'impayé', 200),
                filter: {
                  name: 'payment-failed',
                  conditions: [[{ a: '{{1.type}}', b: 'invoice.payment_failed', o: 'text:equal' }]],
                },
              },
            ],
          },
        ],
        metadata: { designer: { x: 600, y: 0 } },
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
