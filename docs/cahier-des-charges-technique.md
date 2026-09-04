# Cahier des charges technique — Vigie

Architecture no-code (Airtable + Make + Softr + Stripe) pour la surveillance de certificats SSL/TLS et de noms de domaine.

## Sommaire

1. [Limite à connaître avant de commencer](#0-limite-à-connaître-avant-de-commencer)
2. [Schéma Airtable](#1-schéma-airtable)
3. [Scénarios Make](#2-scénarios-make)
4. [Flow Softr](#3-flow-softr)
5. [Synchronisation Stripe](#4-synchronisation-stripe)
6. [Ordre de construction conseillé](#5-ordre-de-construction-conseillé)

---

## 0. Limite à connaître avant de commencer

Make n'a pas de module natif pour :
- ouvrir une connexion TLS et lire la date d'expiration d'un certificat ;
- interroger le WHOIS d'un nom de domaine.

Il faut passer par un module **HTTP** appelant un service tiers :
- **Certificat** : pas d'API gratuite fiable et stable dans la durée — la solution retenue est une **petite fonction serverless maison** en Node.js sur Vercel (runtime Node, pas Edge) qui ouvre une connexion TLS avec le module natif `tls` et lit le certificat du pair. Coût quasi nul, hors du monde "100% no-code" mais incontournable. Code et instructions de déploiement : [`serverless/`](../serverless/README.md). Cloudflare Workers a été écarté : son API de sockets TLS ne redonne que le flux d'octets déchiffré, pas les métadonnées du certificat.
- **WHOIS domaine** : pas besoin d'API payante — **RDAP**, le remplaçant standardisé du WHOIS, est gratuit, sans clé, et répond en JSON structuré au lieu de texte brut à parser. Un module HTTP Make suffit. Détails et limite réelle de couverture ci-dessous (scénario A, étape 4).

C'est le seul écart au tout-no-code. Tout le reste ci-dessous est Airtable/Make/Softr/Stripe sans une ligne de code.

---

## 1. Schéma Airtable

Une base **Vigie**, quatre tables. Créée et vérifiée via l'API Airtable — voir [`scripts/setup-airtable-base.js`](../scripts/setup-airtable-base.js) pour le détail exact des champs, et [`scripts/README.md`](../scripts/README.md) pour la base réellement déployée (ID, URL, ce qui reste à faire à la main).

### `Comptes`
Un enregistrement = un client payant (TPE/PME ou agence/MSP).

| Champ | Type | Notes |
|---|---|---|
| Nom du compte | Texte (champ principal) | |
| Email | Email | identifiant de connexion Softr |
| Type de compte | Sélection unique | `Solo/TPE`, `PME`, `Agence/MSP` |
| Offre | Sélection unique | `Essentiel`, `Pro`, `Agence/MSP` |
| Quota domaines | Nombre | dérivé de l'offre, mis à jour par le scénario Stripe |
| Statut abonnement | Sélection unique | `essai`, `actif`, `impayé`, `annulé` |
| Stripe Customer ID | Texte | |
| Stripe Subscription ID | Texte | |
| Marque blanche — nom affiché | Texte | Agence/MSP uniquement |
| Marque blanche — logo | Pièce jointe | Agence/MSP uniquement |
| Webhook Slack | Texte (URL) | optionnel |
| Numéro SMS alerte | Téléphone | Agence/MSP uniquement |
| Domaines | Lien → `Domaines` | |
| Clients finaux | Lien → `ClientsFinaux` | |
| Date création | Date de création | auto — l'API Airtable ne permet pas de créer ce type de champ, ajouté à la main (30 secondes) |

### `ClientsFinaux`
Utilisé uniquement par les comptes `Agence/MSP` pour regrouper leurs propres clients.

| Champ | Type | Notes |
|---|---|---|
| Nom client | Texte (champ principal) | |
| Compte parent | Lien → `Comptes` | |
| Domaines | Lien → `Domaines` | |
| Contact (info) | Email | pour référence interne, pas d'accès Softr |

### `Domaines`
Table centrale, un enregistrement = un domaine surveillé.

| Champ | Type | Notes |
|---|---|---|
| Nom de domaine | Texte (champ principal) | ex. `boutique-lamarne.fr` |
| Compte | Lien → `Comptes` | |
| Client final | Lien → `ClientsFinaux` | vide si compte Solo/PME |
| Actif | Case à cocher | permet de suspendre la surveillance sans supprimer |
| Statut certificat | Sélection unique | `valide`, `à surveiller`, `urgent`, `erreur` |
| Date expiration certificat | Date | |
| Émetteur certificat | Texte | |
| Statut domaine | Sélection unique | `valide`, `à surveiller`, `urgent`, `erreur` |
| Date expiration domaine | Date | |
| Registrar | Texte | |
| Dernière vérification | Date/heure | |
| Dernière erreur | Texte long | message brut si la vérification échoue |

Vue utile : **"À vérifier aujourd'hui"** = `Actif = true`, groupée par `Compte`, triée par `Date expiration certificat` croissante — c'est cette vue que le scénario Make quotidien parcourt.

### `Alertes`
Journal des envois, pour ne jamais alerter deux fois sur le même palier.

| Champ | Type | Notes |
|---|---|---|
| Domaine | Lien → `Domaines` | |
| Type | Sélection unique | `certificat`, `domaine` |
| Palier | Sélection unique | `J-30`, `J-14`, `J-7`, `J-1`, `expiré` |
| Canal | Sélection unique | `email`, `slack`, `sms` |
| Statut envoi | Sélection unique | `envoyé`, `échec` |
| Date envoi | Date/heure | |

### Relations en un coup d'œil

```
Comptes ─┬─< Domaines >─┬─ ClientsFinaux
         └─< ClientsFinaux
Domaines ─< Alertes
```

---

## 2. Scénarios Make

### A — Vérification quotidienne (cœur du produit)

**Statut : étapes 1-5 construites et testées en conditions réelles** (scénario Make `7224738`, non activé — voir [`scripts/README.md`](../scripts/README.md#setup-make-scenarioajs-et-airtable-schemajson) pour le détail, les identifiants de modules découverts, et les pièges rencontrés). Reste à construire : le routeur d'alerte (étape 6 ci-dessous — structure déjà vérifiée, modules d'envoi email/Slack/SMS pas encore).

Déclenchement : planification, tous les jours à 06h00 (Europe/Paris).

1. **Airtable — Rechercher des enregistrements** : vue `À vérifier aujourd'hui` de `Domaines` (ou `formula: "{Actif} = TRUE()"` en attendant que la vue soit créée). Ce module émet un bundle par domaine trouvé — **pas besoin d'Itérateur séparé**, les modules suivants s'exécutent automatiquement une fois par domaine.
2. **HTTP — Faire une requête** (en-tête `X-Vigie-Key: {{clé secrète}}`) vers la fonction serverless maison, déployée sur Vercel : `GET https://serverless-two-tau.vercel.app/api/cert?domain={{nom_domaine}}` → `{ domain, expires_at, issuer, error }`.
3. **HTTP — Faire une requête** vers RDAP (suit la redirection automatiquement, gratuit, sans clé) : `GET https://rdap.org/domain/{{nom_domaine}}` avec en-têtes `Accept: application/rdap+json` **et `User-Agent: curl/8.21.0`** (testé : sans User-Agent "navigateur/curl", Verisign — le registre de `.com` — renvoie 403 à un client HTTP "machine" ; ça a fait échouer les tests avec le `fetch` par défaut de Node, le module HTTP de Make sera probablement concerné pareil).
   - Réponse `200` : chercher dans le tableau `events` l'élément où `eventAction = "expiration"` et lire son `eventDate` — **Itérateur** sur `events` puis **Filtre** `eventAction = expiration` (l'ordre du tableau n'est pas garanti selon le registre, ne pas se fier à un index fixe). Le registrar est dans `entities` (rôle `registrar`), champ `fn` de son `vcardArray`.
   - Réponse `404` avec `title: "No RDAP service is available for this resource"` : **pas d'échec** — certains registres n'exposent pas encore de RDAP public (confirmé en test sur `.de`, `.eu`, `.io` ; `.fr`, `.com`, `.net`, `.org` fonctionnent). Mettre `Domaines.Statut domaine = erreur` avec un message clair plutôt que de faire échouer le scénario.
   - Réponse `404` avec un autre message : domaine probablement non enregistré ou mal orthographié — même traitement, statut `erreur`.
4. **Outils — Définir des variables** : calcule `jours_restants_cert` et `jours_restants_domaine` (`(date d'expiration − maintenant) / 86400000`, arrondi). La date d'expiration domaine est d'abord extraite du tableau RDAP `events` via la fonction `map()` avec filtre inline — testé avec de vraies données, aucun module Itérateur nécessaire.
5. **Airtable — Mettre à jour un enregistrement** : statut (`valide`/`à surveiller` ≤30j/`urgent` ≤7j/`erreur`), dates, `Dernière vérification` = maintenant. Statut = `erreur` si l'étape 2 ou 3 a renvoyé une erreur (ex. domaine injoignable). Module `airtable:ActionUpdateRecords` : la clé `record` s'indexe par **ID de champ** (`fldXXXXXXXXXXXXXX`, voir [`scripts/airtable-schema.json`](../scripts/airtable-schema.json)), jamais par nom, quel que soit le réglage "Use Column ID" ; les champs Airtable de type Date (pas Date+heure) exigent un format `YYYY-MM-DD`, pas un timestamp complet. Détail des formules et pièges IML rencontrés : [`scripts/README.md`](../scripts/README.md#formules-iml-le-langage-dexpression-de-make--pièges-rencontrés-en-câblant-les-étapes-4-à-6).
6. **Router** à quatre branches par seuil (`jours_restants <= 30`, `<= 14`, `<= 7`, `<= 1`), pour le certificat et pour le domaine :
   - **Filtre** : `jours_restants` (opérateur numérique `number:lessorequal`, catégorie **"Numeric operators"** dans le menu — pas "Time operators", qui existe aussi et se ressemble). Seuils plutôt qu'égalité stricte : un domaine ajouté avec déjà peu de jours restants déclenche directement les paliers déjà dépassés au lieu de les rater silencieusement en attendant le jour exact.
   - **Airtable — Rechercher** dans `Alertes` : un envoi existe-t-il déjà pour ce domaine + ce palier ? Si oui → **arrêt** (pas de doublon).
   - **Router canal** : email toujours ; Slack si `Comptes.Webhook Slack` renseigné ; SMS (module Twilio) si `Comptes.Offre = Agence/MSP` et numéro renseigné.
   - **Airtable — Créer un enregistrement** dans `Alertes` (log de l'envoi, y compris en cas d'échec).

Détail de construction (structure JSON du router/filtre, gotcha "Numeric" vs "Time operators") : [`scripts/README.md`](../scripts/README.md#router-et-filtres-découvert-le-2026-09-04).

### B — Ajout d'un domaine (déclenché depuis Softr)

Déclenchement : **Webhook Make personnalisé**, appelé par le formulaire Softr "Ajouter un domaine".

1. Webhook reçoit `{ compte_id, nom_domaine, client_final_id? }`.
2. **Airtable — Rechercher** le nombre de `Domaines` liés à `compte_id`.
3. **Filtre** : si ce nombre ≥ `Comptes.Quota domaines` → **Webhook response** : erreur `quota_atteint`, message affiché dans Softr ("Passez à l'offre supérieure pour ajouter plus de domaines").
4. Sinon : **Airtable — Créer un enregistrement** dans `Domaines`.
5. Appel immédiat des étapes 3-6 du scénario A pour ce domaine (sous-scénario réutilisable, ou dupliqué) — l'utilisateur voit un statut dès l'ajout, pas seulement le lendemain.
6. **Webhook response** : succès.

### C — Rapport mensuel PDF (offres Pro et Agence/MSP)

Déclenchement : planification, le 1er de chaque mois à 08h00.

1. **Airtable — Rechercher** les `Comptes` avec `Offre` ∈ {Pro, Agence/MSP} et `Statut abonnement = actif`.
2. **Itérateur** par compte.
3. **Airtable — Rechercher** tous les `Domaines` du compte (et de ses `ClientsFinaux` le cas échéant), avec leur statut du mois.
4. **Module PDF** (PDFMonkey ou DocSpring, branché sur Make) : génère le rapport à partir d'un template incluant le logo de marque blanche si renseigné.
5. **Airtable — Mettre à jour** : attache le PDF au compte (champ pièce jointe sur `Comptes`, ou table `Rapports` si l'historique doit être conservé — à ajouter si besoin).
6. **Email** : envoie le rapport au compte.

### D — Synchronisation Stripe → Airtable

Déclenchement : **Webhook Stripe** (module Make Stripe, événements `customer.subscription.created`, `.updated`, `.deleted`, `invoice.payment_failed`).

1. **Router** selon `type` d'événement.
2. **Airtable — Rechercher** le `Compte` par `Stripe Customer ID`.
3. **Airtable — Mettre à jour** : `Offre`, `Quota domaines`, `Statut abonnement` en fonction de l'événement (ex. `payment_failed` → `impayé`).

---

## 3. Flow Softr

| Page | Contenu | Visible pour |
|---|---|---|
| Connexion / Inscription | Auth native Softr, table utilisateurs liée à `Comptes` par email | tous |
| Choix de l'offre | Redirige vers Stripe Checkout (bloc Stripe natif ou Payment Link) | après inscription |
| Tableau de bord | Liste des `Domaines` filtrée sur le compte connecté, pills de statut, tri par urgence | tous |
| Ajout de domaine | Formulaire → **Webhook Make (scénario B)**, pas d'écriture Airtable directe (validation du quota côté serveur) | tous |
| Détail domaine | Historique des vérifications et alertes, bouton "Vérifier maintenant" (webhook à la demande) | tous |
| Clients | CRUD sur `ClientsFinaux`, vue "par client" partageable en lecture seule (marque blanche) | Agence/MSP uniquement |
| Rapports | Liste des PDF mensuels (scénario C) | Pro et Agence/MSP |
| Paramètres | Email d'alerte, webhook Slack, numéro SMS, lien vers le portail client Stripe | tous |

Permissions Softr : **user groups** par `Offre` pour masquer "Clients" et "Rapports" à l'offre Essentiel ; filtrage automatique "enregistrements liés à l'utilisateur connecté" sur `Comptes.Email`, avec filtre en cascade sur `Domaines.Compte`.

---

## 4. Synchronisation Stripe

- Produits Stripe : trois prix récurrents (Essentiel, Pro, Agence/MSP) + tarif "fondateur" en Coupon à durée illimitée pour les 100 premiers inscrits.
- Checkout : bloc Stripe Softr ou Payment Link par offre, `client_reference_id` = `Comptes.record_id` Airtable pour le rapprochement.
- Portail client Stripe (gestion/résiliation) : lien direct depuis la page Paramètres Softr.
- Le scénario D (ci-dessus) est la seule source de vérité pour `Statut abonnement` et `Quota domaines` côté Airtable — jamais mis à jour manuellement.

---

## 5. Ordre de construction conseillé

1. Base Airtable (tables + vues) — 1/2 journée.
2. Fonction serverless de vérification de certificat (le seul bout de code) — écrite et testée, voir [`serverless/`](../serverless/README.md) ; il ne reste qu'à la déployer sur Vercel.
3. Scénario Make A (vérification quotidienne) en le testant sur 3-4 domaines réels — 1 journée.
4. Softr : tableau de bord + connexion, branché en lecture seule sur Airtable — 1 journée.
5. Scénario Make B (ajout de domaine) + formulaire Softr correspondant — 1/2 journée.
6. Stripe + scénario D — 1/2 journée.
7. Fonctionnalités Agence/MSP (`ClientsFinaux`, marque blanche, rapports PDF, scénario C) — une fois les 6 points précédents validés par les premiers inscrits de la liste d'attente.
