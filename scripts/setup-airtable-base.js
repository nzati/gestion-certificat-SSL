#!/usr/bin/env node
'use strict';

/**
 * Crée la base Airtable "Vigie" telle que décrite dans
 * docs/cahier-des-charges-technique.md : 4 tables, leurs champs, puis les
 * liaisons entre tables (ajoutées après coup, une fois les tableId connus).
 *
 * Non idempotent : relancer ce script crée une NOUVELLE base à chaque fois
 * (l'API Airtable n'a pas de "créer si absent"). À exécuter une seule fois ;
 * ce script sert surtout de trace reproductible de comment la base a été
 * construite.
 *
 * Usage : AIRTABLE_TOKEN=pat... WORKSPACE_ID=wsp... node scripts/setup-airtable-base.js
 */

const TOKEN = process.env.AIRTABLE_TOKEN;
const WORKSPACE_ID = process.env.WORKSPACE_ID;

if (!TOKEN || !WORKSPACE_ID) {
  console.error('Usage : AIRTABLE_TOKEN=pat... WORKSPACE_ID=wsp... node scripts/setup-airtable-base.js');
  process.exit(1);
}

const API = 'https://api.airtable.com/v0';

async function airtable(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}\n${JSON.stringify(json, null, 2)}`);
  }
  return json;
}

const select = (...names) => ({ type: 'singleSelect', options: { choices: names.map((name) => ({ name })) } });
const text = { type: 'singleLineText' };
const longText = { type: 'multilineText' };
const email = { type: 'email' };
const url = { type: 'url' };
const phone = { type: 'phoneNumber' };
const attachments = { type: 'multipleAttachments' };
const checkbox = { type: 'checkbox', options: { icon: 'check', color: 'greenBright' } };
const number = { type: 'number', options: { precision: 0 } };
const date = { type: 'date', options: { dateFormat: { name: 'local' } } };
const dateTime = {
  type: 'dateTime',
  options: { dateFormat: { name: 'local' }, timeFormat: { name: '24hour' }, timeZone: 'client' },
};
// createdTime et autoNumber ne peuvent PAS être créés via l'API (confirmé :
// UNSUPPORTED_FIELD_TYPE_FOR_CREATE, y compris en POST sur une table déjà
// existante) — uniquement à la main dans l'interface Airtable. Ce script ne
// les crée donc pas ; voir le README pour l'ajout manuel.

function field(name, spec) {
  return { name, ...spec };
}

async function main() {
  console.log('Création de la base "Vigie"...');

  const base = await airtable('POST', '/meta/bases', {
    name: 'Vigie',
    workspaceId: WORKSPACE_ID,
    tables: [
      {
        name: 'Comptes',
        description: "Un enregistrement = un client payant (TPE/PME ou agence/MSP).",
        fields: [
          field('Nom du compte', text),
          field('Email', email),
          field('Type de compte', select('Solo/TPE', 'PME', 'Agence/MSP')),
          field('Offre', select('Essentiel', 'Pro', 'Agence/MSP')),
          field('Quota domaines', number),
          field('Statut abonnement', select('essai', 'actif', 'impayé', 'annulé')),
          field('Stripe Customer ID', text),
          field('Stripe Subscription ID', text),
          field('Marque blanche — nom affiché', text),
          field('Marque blanche — logo', attachments),
          field('Webhook Slack', url),
          field('Numéro SMS alerte', phone),
        ],
      },
      {
        name: 'ClientsFinaux',
        description: "Utilisé uniquement par les comptes Agence/MSP pour regrouper leurs propres clients.",
        fields: [field('Nom client', text), field('Contact (info)', email)],
      },
      {
        name: 'Domaines',
        description: 'Table centrale : un enregistrement = un domaine surveillé.',
        fields: [
          field('Nom de domaine', text),
          field('Actif', checkbox),
          field('Statut certificat', select('valide', 'à surveiller', 'urgent', 'erreur')),
          field('Date expiration certificat', date),
          field('Émetteur certificat', text),
          field('Statut domaine', select('valide', 'à surveiller', 'urgent', 'erreur')),
          field('Date expiration domaine', date),
          field('Registrar', text),
          field('Dernière vérification', dateTime),
          field('Dernière erreur', longText),
        ],
      },
      {
        name: 'Alertes',
        description: 'Journal des envois, pour ne jamais alerter deux fois sur le même palier.',
        fields: [
          field('Date envoi', dateTime),
          field('Type', select('certificat', 'domaine')),
          field('Palier', select('J-30', 'J-14', 'J-7', 'J-1', 'expiré')),
          field('Canal', select('email', 'slack', 'sms')),
          field('Statut envoi', select('envoyé', 'échec')),
        ],
      },
    ],
  });

  console.log(`Base créée : ${base.id}`);
  const tableId = Object.fromEntries(base.tables.map((t) => [t.name, t.id]));

  console.log('Ajout des liaisons entre tables...');

  async function addLink(sourceTableId, fieldName, linkedTableId) {
    return airtable('POST', `/meta/bases/${base.id}/tables/${sourceTableId}/fields`, {
      name: fieldName,
      type: 'multipleRecordLinks',
      options: { linkedTableId },
    });
  }

  const domainesCompte = await addLink(tableId.Domaines, 'Compte', tableId.Comptes);
  const domainesClientFinal = await addLink(tableId.Domaines, 'Client final', tableId.ClientsFinaux);
  const clientsCompteParent = await addLink(tableId.ClientsFinaux, 'Compte parent', tableId.Comptes);
  const alertesDomaine = await addLink(tableId.Alertes, 'Domaine', tableId.Domaines);

  console.log('Liaisons créées. Renommage des champs miroir générés automatiquement...');

  // Chaque lien crée un champ miroir dans la table liée, nommé d'après la
  // table source par Airtable — on les renomme pour matcher le cahier des
  // charges (ex. "Domaines" sur Comptes plutôt que "Domaines 2").
  async function renameMirror(tableId_, sourceField, newName) {
    const linkedFieldId = sourceField.options && sourceField.options.inverseLinkFieldId;
    if (!linkedFieldId) {
      console.warn(`  (pas de champ miroir détecté pour ${sourceField.name}, à renommer manuellement si besoin)`);
      return;
    }
    await airtable('PATCH', `/meta/bases/${base.id}/tables/${tableId_}/fields/${linkedFieldId}`, {
      name: newName,
    });
  }

  await renameMirror(tableId.Comptes, domainesCompte, 'Domaines');
  await renameMirror(tableId.ClientsFinaux, domainesClientFinal, 'Domaines');
  await renameMirror(tableId.Comptes, clientsCompteParent, 'Clients finaux');
  await renameMirror(tableId.Domaines, alertesDomaine, 'Alertes');

  console.log('\nTerminé.');
  console.log(`Base ID   : ${base.id}`);
  console.log(`URL       : https://airtable.com/${base.id}`);
  console.log('Tables    :', Object.entries(tableId).map(([n, id]) => `${n}=${id}`).join(', '));
  console.log(
    '\nÀ faire à la main dans l\'interface Airtable (non scriptable via l\'API) :\n' +
      '  - Comptes : ajouter un champ "Date création" de type Created time\n' +
      '  - Alertes : ajouter un champ "N°" de type Autonumber\n' +
      '  - Domaines : créer la vue "À vérifier aujourd\'hui" (filtre Actif = true,\n' +
      '    groupée par Compte, triée par Date expiration certificat croissant)',
  );
}

main().catch((err) => {
  console.error('\nÉchec :', err.message);
  process.exit(1);
});
