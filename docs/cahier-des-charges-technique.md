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

**Statut : construit, testé en conditions réelles de bout en bout et actif en production** depuis le 2026-09-04, y compris l'envoi d'alerte et l'anti-doublon (scénario Make `7224738`, tourne tous les jours à 06:00 Europe/Paris — voir [`scripts/README.md`](../scripts/README.md#setup-make-scenarioajs-et-airtable-schemajson) pour le détail, les identifiants de modules découverts, et les pièges rencontrés, dont deux vrais bugs Make/Airtable qui donnaient l'illusion de fonctionner). Restent à ajouter : Slack (webhook HTTP simple, pas de nouveau module à vérifier) et SMS/Twilio (offre Agence/MSP).

Déclenchement : planification, tous les jours à 06h00 (Europe/Paris).

1. **Airtable — Rechercher des enregistrements** : vue `À vérifier aujourd'hui` de `Domaines` (ou `formula: "{Actif} = TRUE()"` en attendant que la vue soit créée). Ce module émet un bundle par domaine trouvé — **pas besoin d'Itérateur séparé**, les modules suivants s'exécutent automatiquement une fois par domaine.
2. **HTTP — Faire une requête** (en-tête `X-Vigie-Key: {{clé secrète}}`) vers la fonction serverless maison, déployée sur Vercel : `GET https://serverless-two-tau.vercel.app/api/cert?domain={{nom_domaine}}` → `{ domain, expires_at, issuer, error }`.
3. **HTTP — Faire une requête** vers RDAP (suit la redirection automatiquement, gratuit, sans clé) : `GET https://rdap.org/domain/{{nom_domaine}}` avec en-têtes `Accept: application/rdap+json` **et `User-Agent: curl/8.21.0`** (testé : sans User-Agent "navigateur/curl", Verisign — le registre de `.com` — renvoie 403 à un client HTTP "machine" ; ça a fait échouer les tests avec le `fetch` par défaut de Node, le module HTTP de Make sera probablement concerné pareil).
   - Réponse `200` : chercher dans le tableau `events` l'élément où `eventAction = "expiration"` et lire son `eventDate` — **Itérateur** sur `events` puis **Filtre** `eventAction = expiration` (l'ordre du tableau n'est pas garanti selon le registre, ne pas se fier à un index fixe). Le registrar est dans `entities` (rôle `registrar`), champ `fn` de son `vcardArray`.
   - Réponse `404` avec `title: "No RDAP service is available for this resource"` : **pas d'échec** — certains registres n'exposent pas encore de RDAP public (confirmé en test sur `.de`, `.eu`, `.io` ; `.fr`, `.com`, `.net`, `.org` fonctionnent). Mettre `Domaines.Statut domaine = erreur` avec un message clair plutôt que de faire échouer le scénario.
   - Réponse `404` avec un autre message : domaine probablement non enregistré ou mal orthographié — même traitement, statut `erreur`.
4. **Outils — Définir des variables** : calcule `jours_restants_cert` et `jours_restants_domaine` (`(date d'expiration − maintenant) / 86400000`, arrondi). La date d'expiration domaine est d'abord extraite du tableau RDAP `events` via la fonction `map()` avec filtre inline — testé avec de vraies données, aucun module Itérateur nécessaire.
5. **Airtable — Mettre à jour un enregistrement** : statut (`valide`/`à surveiller` ≤30j/`urgent` ≤7j/`erreur`), dates, `Dernière vérification` = maintenant. Statut = `erreur` si l'étape 2 ou 3 a renvoyé une erreur (ex. domaine injoignable). Module `airtable:ActionUpdateRecords` : la clé `record` s'indexe par **ID de champ** (`fldXXXXXXXXXXXXXX`, voir [`scripts/airtable-schema.json`](../scripts/airtable-schema.json)), jamais par nom, quel que soit le réglage "Use Column ID" ; les champs Airtable de type Date (pas Date+heure) exigent un format `YYYY-MM-DD`, pas un timestamp complet. Détail des formules et pièges IML rencontrés : [`scripts/README.md`](../scripts/README.md#formules-iml-le-langage-dexpression-de-make--pièges-rencontrés-en-câblant-les-étapes-4-à-6).
6. **Router** à deux branches (certificat, domaine), chacune :
   - **Filtre d'entrée** : `jours_restants <= 30` (opérateur numérique `number:lessorequal`, catégorie **"Numeric operators"** dans le menu — pas "Time operators", qui existe aussi et se ressemble et piège facilement). Un seuil large plutôt que 4 branches par palier : le palier précis (`J-30`/`J-14`/`J-7`/`J-1`) est calculé à part (étape 4bis, `palier_cert`/`palier_domaine`) et sert à la recherche anti-doublon — un domaine ajouté avec déjà peu de jours restants déclenche directement le palier déjà dépassé au lieu de le rater silencieusement en attendant le jour exact.
   - **Airtable — Rechercher** dans `Alertes` : un envoi existe-t-il déjà pour ce domaine + ce type + ce palier ? La formule doit comparer par **nom** de domaine (`ARRAYJOIN({Domaine})`) et non par ID — `ARRAYJOIN` sur un champ de liaison renvoie le nom de l'enregistrement lié, pas son ID technique.
   - **Filtre anti-doublon** : le bundle de recherche a-t-il un `id` réel (`text:equal` contre `""`) ? Si non vide → déjà envoyé, **arrêt**. Ne pas utiliser un agrégateur COUNT pour ça : Search Records émet toujours 1 bundle même à 0 résultat, et COUNT le compte comme `1` aussi bien à 0 qu'à 1 résultat — un filtre `count <= 0` ne passe alors jamais.
   - **Envoi** : email (`google-email:sendAnEmail`, connexion Gmail OAuth) — construit et testé. Slack (webhook HTTP simple vers `Comptes.Webhook Slack`) et SMS (Twilio, offre Agence/MSP) restent à ajouter.
   - **Airtable — Créer un enregistrement** dans `Alertes` (log de l'envoi).

Les deux bugs ci-dessus (agrégateur, `ARRAYJOIN`) ont chacun donné l'illusion de marcher avant d'être repérés en vérifiant le résultat concret (email reçu, contenu réel d'Airtable) plutôt que les pastilles vertes du canvas Make. Détail complet, avec la séquence de vérification à reproduire : [`scripts/README.md`](../scripts/README.md#envoi-email-et-anti-doublon-découvert-le-2026-09-04--la-partie-qui-a-le-plus-mal-tourné-avant-de-marcher).

### B — Ajout d'un domaine (déclenché depuis Softr)

**Statut : construit et testé en conditions réelles dans les deux cas** (scénario Make `7237349`, actif — voir [`scripts/README.md`](../scripts/README.md#setup-make-scenariobjs)). Testé : ajout sous quota (domaine créé, vérifié immédiatement, statut correct dans Airtable) et ajout au quota atteint (refusé proprement, aucun enregistrement créé). Non câblés : le champ `Client final` optionnel, et un garde-fou si `compte_id` ne correspond à aucun compte.

Déclenchement : **Webhook Make personnalisé**, appelé par le formulaire Softr "Ajouter un domaine" — URL : `https://hook.eu1.make.com/heih2dqkyad6uouwfhezkxk9awe1kj2u`.

1. Webhook reçoit `{ compte_id, nom_domaine, client_final_id? }` — un webhook JSON Make expose ses clés directement à plat sur le bundle (`{{1.compte_id}}`), pas de sous-objet à traverser.
2. **Airtable — Rechercher** le compte (`RECORD_ID() = "{{1.compte_id}}"`) pour lire `Quota domaines` et son nom.
3. **Airtable — Rechercher** les `Domaines` liés à ce compte (comparaison par **nom** du compte via `ARRAYJOIN({Compte})`, pas par ID — même piège que pour `Alertes` dans le scénario A), puis compter via l'agrégateur COUNT.
4. **Router** à deux branches, sans opérateur `>=` (seul `number:lessorequal` est vérifié à ce jour) donc comparées dans les deux sens avec le même opérateur :
   - Route "autorisé" (`compte <= quota - 1`) : **Airtable — Créer un enregistrement** dans `Domaines`, puis la même vérification immédiate que le scénario A (HTTP certificat, HTTP RDAP, calcul des jours restants, mise à jour Airtable) pour que le statut soit disponible dès l'ajout plutôt que d'attendre le lendemain, puis **Webhook response** succès (`{"ok": true, "domaine_id": "..."}`).
   - Route "quota atteint" (`quota <= compte`) : **Webhook response** erreur (`{"ok": false, "error": "quota_atteint", ...}`), message affiché dans Softr ("Passez à l'offre supérieure pour ajouter plus de domaines").

### C — Rapport mensuel PDF (offres Pro et Agence/MSP)

Déclenchement : planification, le 1er de chaque mois à 08h00.

1. **Airtable — Rechercher** les `Comptes` avec `Offre` ∈ {Pro, Agence/MSP} et `Statut abonnement = actif`.
2. **Itérateur** par compte.
3. **Airtable — Rechercher** tous les `Domaines` du compte (et de ses `ClientsFinaux` le cas échéant), avec leur statut du mois.
4. **Module PDF** (PDFMonkey ou DocSpring, branché sur Make) : génère le rapport à partir d'un template incluant le logo de marque blanche si renseigné.
5. **Airtable — Mettre à jour** : attache le PDF au compte (champ pièce jointe sur `Comptes`, ou table `Rapports` si l'historique doit être conservé — à ajouter si besoin).
6. **Email** : envoie le rapport au compte.

### D — Synchronisation Stripe → Airtable

**Statut : construit et testé avec des événements simulés** (scénario Make `7237822`, non activé — voir [`scripts/README.md`](../scripts/README.md#setup-make-scenariodjs)). Testé avec le format JSON réel de Stripe (pas un vrai compte Stripe, qui n'existe pas encore) sur les 3 transitions : `subscription.updated` → actif, `payment_failed` → impayé, `subscription.deleted` → annulé, toutes confirmées correctes dans Airtable. `Offre` et `Quota domaines` ne sont **pas câblés** : la correspondance prix Stripe → offre suppose des produits Stripe réels, pas encore créés.

Déclenchement : **Webhook Make générique** (pas le module Stripe officiel — évite une connexion OAuth Stripe ; Stripe POST un JSON standard que n'importe quel webhook reçoit à l'identique) — URL : `https://hook.eu1.make.com/hwmvkwhklzhd8t3laj3oq38vmlhnf7c8`, à coller dans Stripe (Developers → Webhooks → Add endpoint) une fois le compte créé, pour les événements `customer.subscription.created`, `.updated`, `.deleted`, `invoice.payment_failed`.

1. **Airtable — Rechercher** le `Compte` par `Stripe Customer ID` (`{{1.data.object.customer}}` — un webhook Make préserve la structure JSON imbriquée telle quelle, pas d'aplatissement).
2. **Router** à 3 branches selon `{{1.type}}` :
   - `customer.subscription.created` ou `.updated` → `Statut abonnement` dérivé du champ Stripe `status` (`active`→`actif`, `trialing`→`essai`, `past_due`/`unpaid`→`impayé`, sinon `annulé`).
   - `customer.subscription.deleted` → `Statut abonnement = annulé`.
   - `invoice.payment_failed` → `Statut abonnement = impayé`.
3. Pas de module "Webhook response" nécessaire : un scénario déclenché par webhook répond automatiquement `Accepted` (HTTP 200), suffisant pour Stripe qui ne regarde que le code de statut.

---

## 3. Flow Softr

**Statut : app créée et testée en conditions réelles pour le cœur du flow** (générée via l'IA de Softr Studio, connectée à la base Airtable Vigie). Testé avec un vrai compte, publié, connexion réelle par email : la page "Ajouter un domaine" appelle bien le webhook du scénario B (formulaire → Make → vérification immédiate → retour dans le portail), vérifié avec un vrai domaine (`wikipedia.org`) apparaissant avec le bon statut. Pages Clients finaux, Rapports, Paramètres avancés et connexion Stripe pas encore construites.

**Piège trouvé et corrigé — noms de champs du webhook** : le champ caché du formulaire Softr envoie ses valeurs sous le **libellé du champ** (`"Nom de domaine"`, `"Compte"`), pas sous un nom technique du genre `nom_domaine`/`compte_id` comme on pouvait le supposer. Repéré en inspectant le bundle réellement reçu par le webhook Make après un premier essai raté (la branche "quota atteint" se déclenchait à tort, `compte_id` étant vide). Le scénario B a été corrigé pour utiliser `{{1.\`Nom de domaine\`}}` et `{{1.\`Compte\`}}`. Pour le champ "Compte" caché (auteur du formulaire), choisir la valeur dynamique **"Record ID"** de l'utilisateur connecté (pas "Email") — c'est ce qui correspond à l'ID Airtable attendu par `RECORD_ID() = "{{1.\`Compte\`}}"`.

**Bug de sécurité trouvé et corrigé — filtrage par compte manquant** : la page "Domaines" générée par l'IA affichait **tous** les domaines de la base, pas seulement ceux du compte connecté (repéré : un domaine appartenant à aucun compte apparaissait quand même dans la liste d'un utilisateur connecté). Cause : la section "Record filters" du bloc était vide par défaut — Softr ne filtre pas automatiquement par utilisateur connecté, il faut l'ajouter explicitement (Source → Record filters → condition `Compte` `Includes any of` `Nom du compte` [logged-in user]). **Point de vigilance avant d'inviter un vrai client** : vérifier systématiquement le filtrage de chaque page/bloc listant `Domaines` (dashboard Home, page Domaines, page Domaine Details) plutôt que de supposer qu'il est appliqué par défaut. Un widget "Chart" (compteur "Domaines surveillés") reste incohérent après ce correctif (affiche le total non filtré) — cosmétique, pas une fuite de données réelle, à reprendre plus tard.

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

**Statut : produits, prix et Payment Links créés et testés en mode test** (voir [`scripts/README.md`](../scripts/README.md#stripe-2026-09-05-mode-test)). Facturation **avec TVA**, prix **TTC fixes** (9€/29€/79€, quelle que soit la TVA — décision explicite plutôt que HT + TVA en plus) via `tax_behavior: inclusive` sur chaque Price. Le tarif "fondateur" n'est **pas** implémenté via un Coupon Stripe : plus simple et plus standard, chaque prix créé aujourd'hui (9/29/79€) restera figé pour les abonnements qui l'utilisent même si le prix public change plus tard pour les nouveaux inscrits (comportement natif d'un Price Stripe) — il suffira de créer de nouveaux Price à un tarif plus élevé pour les 101e inscrits et de ne plus proposer les Payment Links actuels, sans toucher aux abonnés déjà en cours.

- Checkout : Payment Link par offre (voir tableau dans `scripts/README.md`), pas encore intégrés dans Softr.
- Portail client Stripe (gestion/résiliation) : lien direct depuis la page Paramètres Softr — pas encore fait.
- **Manque encore avant utilisation réelle** : le scénario D ne gère que la mise à jour d'un `Compte` déjà existant (recherché par `Stripe Customer ID`) — il faut ajouter la création d'un nouveau `Compte` pour un client qui s'abonne directement via un Payment Link sans passer par une inscription préalable dans Airtable.
- Le scénario D reste la seule source de vérité pour `Statut abonnement` et `Quota domaines` côté Airtable — jamais mis à jour manuellement.

---

## 5. Ordre de construction conseillé

1. Base Airtable (tables + vues) — 1/2 journée.
2. Fonction serverless de vérification de certificat (le seul bout de code) — écrite et testée, voir [`serverless/`](../serverless/README.md) ; il ne reste qu'à la déployer sur Vercel.
3. Scénario Make A (vérification quotidienne) en le testant sur 3-4 domaines réels — 1 journée.
4. Softr : tableau de bord + connexion, branché en lecture seule sur Airtable — 1 journée.
5. Scénario Make B (ajout de domaine) + formulaire Softr correspondant — 1/2 journée.
6. Stripe + scénario D — 1/2 journée.
7. Fonctionnalités Agence/MSP (`ClientsFinaux`, marque blanche, rapports PDF, scénario C) — une fois les 6 points précédents validés par les premiers inscrits de la liste d'attente.
