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
 * Création de compte (ajouté le 2026-09-05, une fois les vrais produits
 * Stripe créés — voir scripts/README.md § Stripe) : sur
 * `checkout.session.completed`, si aucun `Compte` n'a ce
 * `Stripe Customer ID`, on en crée un. `Offre`/`Quota domaines` sont
 * dérivés de `amount_total` (900/2900/7900 centimes) plutôt que du Price
 * ID — plus simple, pas besoin d'appeler l'API Stripe pour résoudre les
 * line items du checkout, et les 3 montants sont uniques par offre. Email
 * et nom viennent de `customer_details` (présent uniquement sur
 * `checkout.session.completed`, pas sur les événements `subscription.*`).
 * Quota "illimité" de l'offre Agence/MSP encodé comme `99999` (le champ
 * Airtable est un nombre, pas un texte).
 *
 * Testé en conditions réelles avec un vrai paiement de test Stripe (carte
 * 4242..., aucun argent réel) : compte créé avec les bons Offre/Quota/
 * Statut/IDs Stripe, retrouvé via `filterByFormula` sur Email. A aussi
 * révélé un vrai bug en le testant : Stripe a livré `customer.subscription
 * .created` AVANT `checkout.session.completed` pour un même paiement (l'
 * ordre entre événements liés n'est pas garanti), ce qui faisait planter
 * la mise à jour du Compte avec une 422 Airtable puisqu'aucun Compte
 * n'existait encore. Voir `compteTrouveCondition` plus bas pour le
 * garde-fou (et les deux tentatives qui n'ont pas marché avant celle-là).
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
// "Compte déjà trouvé" — nécessaire sur les 3 branches de mise à jour pour
// ne pas planter quand Stripe envoie customer.subscription.created AVANT
// checkout.session.completed (l'ordre n'est pas garanti, confirmé en
// conditions réelles : Stripe a livré les deux dans cet ordre pour un
// même paiement). Sans ce garde-fou, la mise à jour tente d'écrire sur un
// "id" vide et échoue avec une 422 Airtable peu explicite.
//
// PIÈGE : `{a: "{{2.id}}", b: "", o: "text:equal", not: true}` a semblé
// une solution plus directe mais NE MARCHE PAS — le flag "not" est soit
// ignoré soit mal interprété par Make (confirmé par un test réel : la
// branche continuait à matcher et à planter). Idem pour
// `{{2.id != ""}}` : `2.id` absent vaut probablement `null`/`undefined`
// plutôt qu'une chaîne vide, et `null != ""` s'évalue à vrai. Le test de
// vérité `if(2.id; ...)` (déjà utilisé ailleurs dans ce projet, ex.
// `if(2.data.error; ...)`) fonctionne correctement dans les deux cas.
const compteTrouveFormula = '{{if(2.id; "trouve"; "pas-trouve")}}';
const compteTrouveCondition = { a: compteTrouveFormula, b: 'trouve', o: 'text:equal' };

const statutFormula =
  '{{if(1.data.object.status = "active"; "actif"; ' +
  'if(1.data.object.status = "trialing"; "essai"; ' +
  'if(1.data.object.status = "past_due"; "impayé"; ' +
  'if(1.data.object.status = "unpaid"; "impayé"; "annulé"))))}}';

const nomFormula = '{{if(1.data.object.customer_details.name; 1.data.object.customer_details.name; 1.data.object.customer_details.email)}}';
const offreFormula =
  '{{if(1.data.object.amount_total = 900; "Essentiel"; ' +
  'if(1.data.object.amount_total = 2900; "Pro"; "Agence/MSP"))}}';
const quotaFormula = '{{if(1.data.object.amount_total = 900; 10; if(1.data.object.amount_total = 2900; 50; 99999))}}';

function createCompte(id, y) {
  return {
    id,
    module: 'airtable:ActionCreateRecord',
    version: 3,
    parameters: { __IMTCONN__: Number(AIRTABLE_CONNECTION_ID) },
    filter: {
      name: 'nouveau-client',
      conditions: [
        [
          { a: '{{1.type}}', b: 'checkout.session.completed', o: 'text:equal' },
          { a: '{{2.id}}', b: '', o: 'text:equal' },
        ],
      ],
    },
    mapper: {
      base: BASE_ID,
      table: comptes.id,
      record: {
        [comptes.fields['Nom du compte']]: nomFormula,
        [comptes.fields['Email']]: '{{1.data.object.customer_details.email}}',
        [comptes.fields['Stripe Customer ID']]: '{{1.data.object.customer}}',
        [comptes.fields['Stripe Subscription ID']]: '{{1.data.object.subscription}}',
        [comptes.fields['Offre']]: offreFormula,
        [comptes.fields['Quota domaines']]: quotaFormula,
        [comptes.fields['Statut abonnement']]: 'actif',
      },
      typecast: false,
      useColumnId: false,
    },
    metadata: { designer: { x: 900, y } },
  };
}

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
  console.log('  checkout.session.completed, customer.subscription.created,');
  console.log('  customer.subscription.updated, customer.subscription.deleted,');
  console.log('  invoice.payment_failed');

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
            // Nouveau client : checkout complété et aucun Compte existant
            // pour ce Stripe Customer ID.
            flow: [createCompte(41, 400)],
          },
          {
            // Abonnement créé ou mis à jour : statut dérivé de Stripe "status".
            flow: [
              {
                ...updateStatut(11, statutFormula, -200),
                filter: {
                  name: 'subscription-created-ou-updated',
                  conditions: [
                    [{ a: '{{1.type}}', b: 'customer.subscription.created', o: 'text:equal' }, compteTrouveCondition],
                    [{ a: '{{1.type}}', b: 'customer.subscription.updated', o: 'text:equal' }, compteTrouveCondition],
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
                  conditions: [[{ a: '{{1.type}}', b: 'customer.subscription.deleted', o: 'text:equal' }, compteTrouveCondition]],
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
                  conditions: [[{ a: '{{1.type}}', b: 'invoice.payment_failed', o: 'text:equal' }, compteTrouveCondition]],
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
