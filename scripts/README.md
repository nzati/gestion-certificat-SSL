# Scripts de mise en place

## `setup-make-scenario-a.js` et `airtable-schema.json`

Construit, via l'API Make (`developers.make.com`), le scénario A (vérification quotidienne) au complet : Airtable Search Records (Domaines, `Actif = TRUE()`) → HTTP vérification certificat → HTTP RDAP → calcul des jours restants → mise à jour Airtable (statuts, dates, dernière vérification) → router d'alerte (certificat / domaine, seuil ≤30j, anti-doublon, envoi email, log dans Alertes). Manquent encore : Slack (webhook HTTP simple, pas de module à vérifier) et SMS/Twilio (offre Agence/MSP) — voir le commentaire de fin de fichier dans le script.

### Scénario déjà créé et testé en conditions réelles

| | |
|---|---|
| Nom | Vigie — A. Vérification quotidienne |
| Scenario ID | `7224738` |
| URL | https://eu1.make.com/2629311/scenarios/7224738/edit |
| Statut | 13 modules — recherche → vérif certificat → vérif RDAP → 3× calcul → mise à jour Airtable → router (certificat/domaine, anti-doublon, envoi email, log). Testé bout en bout sur un vrai enregistrement (`github.com`) : jours restants, statuts, dates, envoi d'email réel et anti-doublon tous confirmés corrects — y compris deux allers-retours où l'anti-doublon s'est révélé cassé en test réel malgré une apparence de succès (voir plus bas). **Actif depuis le 2026-09-04** — tourne tous les jours à 06:00 Europe/Paris. |
| Planification | Quotidien 06:00 Europe/Paris |

### Découvertes faites en le construisant (aucune n'est documentée publiquement de façon fiable — l'API Make n'expose pas de catalogue de modules interrogeable avec les scopes standards)

Méthode : faire ajouter un module à la main dans l'éditeur visuel Make (2 minutes de clics), puis lire sa structure réelle via `GET /api/v2/scenarios/{id}/blueprint` — beaucoup plus fiable que deviner les identifiants de module et se retrouver avec un scénario silencieusement cassé.

- Identifiants de modules confirmés : `airtable:ActionSearchRecords` (v3), `airtable:ActionCreateRecord` (v3, singulier), `airtable:ActionUpdateRecords` (v3, **pluriel** — piège), `http:MakeRequest` (v4), `util:SetVariable2` (v1).
- **Piège le plus coûteux** : une référence à un champ Airtable dont le nom contient un espace (ex. "Nom de domaine") doit être entourée de backticks dans une expression Make : `{{1.\`Nom de domaine\`}}`. Sans les backticks (`{{1.Nom de domaine}}`), l'éditeur visuel affiche pourtant un mapping qui a l'air correct (jolie pastille bleue) — mais à l'exécution, la valeur est silencieusement vide, sans erreur. Repéré uniquement en inspectant l'output réel d'une exécution de test.
- Un module Airtable Create/Update Record mappe ses valeurs via une clé `"record"` (pas `"fields"`), et cette clé est **toujours indexée par ID de champ** (`fldXXXXXXXXXXXXXX`), jamais par nom — même avec `useColumnId: false`. `airtable-schema.json` donne la table de correspondance nom → ID de champ pour les 4 tables, nécessaire pour construire tout module Create/Update.
- Le mode "Daily" de l'UI de planification est en réalité encodé comme `{"type":"indefinitely","interval":900,"restrict":[{"days":[1,2,3,4,5,6,0],"time":["06:00","06:01"]}]}` — un déclencheur "toutes les 15 min" restreint à une fenêtre d'1 minute par jour. Deviner `{"type":"daily", ...}` aurait été faux et probablement silencieusement retombé sur l'intervalle 15 min par défaut.
- Ajouter un module via le "+" du canvas crée parfois un **scénario séparé** au lieu de l'attacher au flux (arrivé deux fois pendant la construction) — toujours vérifier avec `GET .../blueprint` que le module attendu est bien dans `flow`, pas dans un scénario à côté ni dans `metadata.designer.orphans`.
- La connexion Airtable créée une fois dans l'UI (`__IMTCONN__`) est réutilisable dans tous les scénarios suivants sans avoir à la recréer.

### Router et filtres (découvert le 2026-09-04)

Structure réelle d'un module Router dans une blueprint Make :

```json
{
  "id": 2,
  "mapper": null,
  "module": "builtin:BasicRouter",
  "version": 1,
  "routes": [
    { "flow": [ { "id": 3, "filter": { "name": "...", "conditions": [[ {"a": "...", "b": "...", "o": "..."} ]] }, "module": "...", ... } ] },
    { "flow": [ ... ] }
  ]
}
```

`conditions` est un tableau de groupes **OR**, chaque groupe un tableau de conditions **AND** (`a`/`b` = les deux valeurs, `o` = code opérateur).

**Piège** : l'éditeur visuel propose UNE SEULE entrée "Greater than" par défaut dans la recherche généraliste du menu d'opérateurs, qui se résout en `time:greater` — un opérateur pour les comparaisons de date/heure, pas pour les nombres. Il existe une catégorie séparée **"Numeric operators"** (visible en tapant dans la recherche du menu, ex. "le" pour "less than") avec ses propres codes, ex. `number:lessorequal` pour "Less than or equal to". Toujours vérifier la catégorie affichée dans le menu déroulant ("Numeric operators: ..." vs "Time operators: ..." vs "Datetime operators: ...") avant de valider — ne pas se fier à la première entrée qui matche le texte tapé.

Opérateurs numériques confirmés : `number:lessorequal` ("Less than or equal to"). Les autres (`number:equal`, `number:greaterorequal`, `number:less`, `number:greater`) suivent vraisemblablement le même schéma de nommage mais n'ont pas été vérifiés individuellement — à confirmer avant de les utiliser, même schéma que ci-dessus.

**Choix de conception qui en découle** : plutôt qu'une égalité stricte `jours_restants = 30 OU 14 OU 7 OU 1` (fragile — un jour de scénario manqué et le palier exact est raté), le routeur du scénario A utilisera des seuils `jours_restants <= 30`, `<= 14`, `<= 7`, `<= 1` sur des routes séparées, chacune avec sa propre recherche anti-doublon dans `Alertes` (par domaine + palier). Un domaine ajouté avec déjà peu de jours restants déclenche alors immédiatement les paliers déjà dépassés, au lieu de les rater silencieusement — plus robuste, et ça n'utilise que l'opérateur déjà confirmé.

### Envoi email et anti-doublon (découvert le 2026-09-04) — la partie qui a le plus mal tourné avant de marcher

Module d'envoi confirmé : `google-email:sendAnEmail` (v4), mapper `{ to: [email...], subject, bodyType: "rawHtml", content }`, connexion Gmail OAuth (`__IMTCONN__`). Reconnecter le compte Gmail redemande parfois le scope d'envoi même si une connexion existe déjà (403 `insufficient authentication scopes` observé) — supprimer et recréer la connexion si ça arrive.

**Deux bugs réels, pas des fautes de frappe, découverts uniquement parce que le résultat concret (email reçu, ligne créée dans Airtable) a été vérifié après chaque changement plutôt que de se fier aux pastilles vertes du canvas** :

1. **L'agrégateur numérique (`util:FunctionAggregator2`, fonction `count`) compte les bundles reçus, pas les résultats réels.** Un module Airtable Search Records émet **toujours au moins 1 bundle**, même à 0 résultat — un bundle "marqueur" portant `__IMTLENGTH__: 0` plutôt que des données réelles. L'agrégateur COUNT compte ce marqueur comme une unité : son résultat vaut `1` aussi bien pour "0 correspondance" que pour "1 correspondance", donc un filtre `count <= 0` ne passe **jamais**, même quand il faudrait. Premier symptôme trompeur : un test a semblé "bien bloquer l'envoi en double" alors qu'en réalité il bloquait *tout le temps*, coïncidence masquée par le fait qu'un doublon existait déjà à ce moment précis. Solution retenue : abandonner l'agrégateur, vérifier directement si le bundle de recherche porte un champ `id` réel (`{{recherche.id}} = ""` via l'opérateur `text:equal` déjà confirmé) plutôt que de compter quoi que ce soit. La sortie réelle de l'agrégateur s'appelle d'ailleurs `result`, pas `value` (piège séparé, repéré avant celui-ci) — son `mapper.value` en entrée sert seulement pour sum/avg/max/min, pas pour count.
2. **`ARRAYJOIN({ChampLien})` sur un champ de liaison Airtable renvoie le nom (champ principal) des enregistrements liés, pas leur ID.** Une formule de recherche anti-doublon `FIND("recXXXXXXXXXXXXXX", ARRAYJOIN({Domaine}))` ne matche donc **jamais**, même quand le lien existe réellement — `ARRAYJOIN` produit `"github.com"`, pas `"rec1Mt5UEGbMp156K"`. Repéré en observant un vrai doublon créé dans Airtable malgré un enregistrement déjà existant pour le même domaine/type/palier. Corrigé en cherchant `FIND("{{1.\`Nom de domaine\`}}", ARRAYJOIN({Domaine}))` — le nom, pas l'ID.

Séquence de vérification qui a permis de choper ça (à refaire pour toute nouvelle branche de dedup) : (1) envoyer sans condition pour confirmer que l'envoi lui-même marche, (2) vérifier l'enregistrement réel créé dans Airtable — pas seulement le badge vert du canvas, (3) relancer avec la condition anti-doublon active et confirmer qu'aucun second envoi ni doublon Airtable n'apparaît.

### Formules IML (le langage d'expression de Make) — pièges rencontrés en câblant les étapes 4 à 6

- **`<>` n'est pas un opérateur valide** dans une expression IML (`{{...}}`) — erreur au run : `Invalid IML for parameter ... Operator next to operator`. Utiliser `!=`.
- **Un champ Airtable de type Date (pas Date+heure) rejette un timestamp complet** — erreur `[422] Field "..." cannot accept the provided value`. Formater explicitement : `{{formatDate(parseDate(...); "YYYY-MM-DD")}}` plutôt que de passer la valeur ISO brute (`2026-11-30T23:59:59.000Z`) telle quelle.
- `map(collection; sortie; clé_filtre; valeur_filtre)` fonctionne bien pour chercher une entrée dans un tableau (ex. l'événement `expiration` dans `events` d'une réponse RDAP) sans avoir besoin d'un module Itérateur séparé — confirmé en le testant avec de vraies données (`get(map(3.data.events; "eventDate"; "eventAction"; "expiration"); 1)` a renvoyé la bonne date).
- La soustraction de deux dates (`parseDate(...) - now`) renvoie une différence en **millisecondes** — diviser par `86400000` pour obtenir des jours, confirmé avec des valeurs réelles (87 et 35 jours, cohérentes avec les dates constatées).

## `test-rdap.js`

Vérifie l'expiration d'un nom de domaine via RDAP (le remplaçant standardisé du WHOIS — gratuit, sans clé, réponse JSON). Sert de référence pour le module HTTP + Itérateur/Filtre à construire dans Make (scénario A, étape 4 du [cahier des charges](../docs/cahier-des-charges-technique.md)).

```bash
node scripts/test-rdap.js exemple.fr
```

Testé sur `.fr`, `.com`, `.net`, `.org` (fonctionnent) et `.de`, `.eu`, `.io` (pas de RDAP public — le script renvoie une erreur explicite plutôt que de planter). Un `User-Agent` de type navigateur/curl est nécessaire : Verisign (registre `.com`) renvoie 403 sans ça.

## `setup-make-scenario-b.js`

Construit le scénario B (ajout de domaine par webhook) via l'API Make : webhook `{compte_id, nom_domaine, client_final_id?}` → recherche du compte et de ses domaines existants → si sous quota, crée le domaine, lance la même vérification immédiate que le scénario A (certificat + RDAP), répond succès ; sinon répond `quota_atteint`. Détails complets et raisonnement dans l'en-tête du script.

### Scénario déjà créé et testé en conditions réelles

| | |
|---|---|
| Nom | Vigie — B. Ajout de domaine |
| Scenario ID | `7237349` |
| URL Make | https://eu1.make.com/2629311/scenarios/7237349/edit |
| Webhook | `https://hook.eu1.make.com/heih2dqkyad6uouwfhezkxk9awe1kj2u` (hook id `3661663`) |
| Statut | Testé en conditions réelles dans les deux cas : sous quota (domaine créé, vérifié, statut correct dans Airtable) et quota atteint (refusé, aucun enregistrement créé). **Actif depuis le 2026-09-04.** |

### Découvertes propres à ce scénario

- Modules : `gateway:CustomWebHook` (déclencheur, `parameters.hook` référence un webhook créé séparément via `POST /api/v2/hooks`, scope `hooks:write`) et `gateway:WebhookRespond` (réponse, `mapper: {status, body, headers}`).
- Un webhook JSON expose ses clés **directement à plat** sur le bundle (`{{1.compte_id}}`), pas de sous-objet à traverser — confirmé en envoyant une vraie requête de test et en inspectant le bundle capturé.
- Aucun opérateur `>=` vérifié à ce jour (seulement `number:lessorequal`, voir plus haut) : la vérification de quota compare dans les deux sens avec le même opérateur — route "autorisé" : `compte <= quota - 1` ; route "quota atteint" : `quota <= compte`. Équivalents et complémentaires pour des entiers, donc pas besoin d'un nouvel opérateur ni d'une route "fallback".
- Le comptage des domaines existants réutilise l'agrégateur COUNT (imprécis à 0 résultat réel, voir plus haut) — sans conséquence ici car les quotas réels sont toujours ≥ 1.
- Simplifications assumées, non testées : le champ `Client final` (optionnel) n'est pas câblé sur la création, et il n'y a pas de garde-fou si `compte_id` ne correspond à aucun compte réel.

## `setup-airtable-base.js`

Crée la base Airtable "Vigie" (4 tables + liaisons) via l'API Airtable, telle que décrite dans [le cahier des charges technique](../docs/cahier-des-charges-technique.md#1-schéma-airtable).

```bash
AIRTABLE_TOKEN=pat... WORKSPACE_ID=wsp... node scripts/setup-airtable-base.js
```

Non idempotent — relancer ce script crée une **nouvelle** base à chaque fois. Il documente comment la base existante a été construite, il ne sert pas à la reconstruire en routine.

### Base déjà créée

| | |
|---|---|
| Base ID | `apptozA0MNHsGlSNw` |
| URL | https://airtable.com/apptozA0MNHsGlSNw |
| Comptes | `tblvuWyiuiDy1zCc1` |
| ClientsFinaux | `tblr3ATO7PvysvskJ` |
| Domaines | `tblrKZ0cOKLY7Q5fk` |
| Alertes | `tblRcM8YbaKEFuMNr` |

### Limites de l'API découvertes en la construisant

Deux types de champs renvoient systématiquement `UNSUPPORTED_FIELD_TYPE_FOR_CREATE` — à la création de la table comme en ajout après coup, donc pas contournable en script :

- `createdTime` (Date de création)
- `autoNumber` (Numéro auto-incrémenté)

Il n'y a pas non plus d'endpoint fonctionnel pour créer une vue avec filtre/tri/regroupement via l'API (testé, `INVALID_REQUEST_UNKNOWN`).

### Reste à faire à la main dans l'interface Airtable (10 minutes, une fois)

1. Table `Comptes` → ajouter un champ **Date création**, type *Created time*.
2. Table `Alertes` → ajouter un champ **N°**, type *Autonumber*.
3. Table `Domaines` → créer la vue **"À vérifier aujourd'hui"** : filtre `Actif = true`, groupée par `Compte`, triée par `Date expiration certificat` croissant. C'est cette vue que le scénario Make A (vérification quotidienne) doit parcourir.
