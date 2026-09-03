# Scripts de mise en place

## `setup-make-scenario-a.js` et `airtable-schema.json`

Construit, via l'API Make (`developers.make.com`), le début du scénario A (vérification quotidienne) : Airtable Search Records (Domaines, `Actif = TRUE()`) → HTTP vérification certificat → HTTP RDAP. La branche d'alerte (router, anti-doublon, envoi, mise à jour Airtable) n'est **pas encore construite** — voir le commentaire de fin de fichier.

### Scénario déjà créé et testé en conditions réelles

| | |
|---|---|
| Nom | Vigie — A. Vérification quotidienne |
| Scenario ID | `7224738` |
| URL | https://eu1.make.com/2629311/scenarios/7224738/edit |
| Statut | Créé, testé (Run once sur un vrai enregistrement `github.com`), **pas activé** |
| Planification | Quotidien 06:00 Europe/Paris |

### Découvertes faites en le construisant (aucune n'est documentée publiquement de façon fiable — l'API Make n'expose pas de catalogue de modules interrogeable avec les scopes standards)

Méthode : faire ajouter un module à la main dans l'éditeur visuel Make (2 minutes de clics), puis lire sa structure réelle via `GET /api/v2/scenarios/{id}/blueprint` — beaucoup plus fiable que deviner les identifiants de module et se retrouver avec un scénario silencieusement cassé.

- Identifiants de modules confirmés : `airtable:ActionSearchRecords` (v3), `airtable:ActionCreateRecord` (v3, singulier), `airtable:ActionUpdateRecords` (v3, **pluriel** — piège), `http:MakeRequest` (v4), `util:SetVariable2` (v1).
- **Piège le plus coûteux** : une référence à un champ Airtable dont le nom contient un espace (ex. "Nom de domaine") doit être entourée de backticks dans une expression Make : `{{1.\`Nom de domaine\`}}`. Sans les backticks (`{{1.Nom de domaine}}`), l'éditeur visuel affiche pourtant un mapping qui a l'air correct (jolie pastille bleue) — mais à l'exécution, la valeur est silencieusement vide, sans erreur. Repéré uniquement en inspectant l'output réel d'une exécution de test.
- Un module Airtable Create/Update Record mappe ses valeurs via une clé `"record"` (pas `"fields"`), et cette clé est **toujours indexée par ID de champ** (`fldXXXXXXXXXXXXXX`), jamais par nom — même avec `useColumnId: false`. `airtable-schema.json` donne la table de correspondance nom → ID de champ pour les 4 tables, nécessaire pour construire tout module Create/Update.
- Le mode "Daily" de l'UI de planification est en réalité encodé comme `{"type":"indefinitely","interval":900,"restrict":[{"days":[1,2,3,4,5,6,0],"time":["06:00","06:01"]}]}` — un déclencheur "toutes les 15 min" restreint à une fenêtre d'1 minute par jour. Deviner `{"type":"daily", ...}` aurait été faux et probablement silencieusement retombé sur l'intervalle 15 min par défaut.
- Ajouter un module via le "+" du canvas crée parfois un **scénario séparé** au lieu de l'attacher au flux (arrivé deux fois pendant la construction) — toujours vérifier avec `GET .../blueprint` que le module attendu est bien dans `flow`, pas dans un scénario à côté ni dans `metadata.designer.orphans`.
- La connexion Airtable créée une fois dans l'UI (`__IMTCONN__`) est réutilisable dans tous les scénarios suivants sans avoir à la recréer.

## `test-rdap.js`

Vérifie l'expiration d'un nom de domaine via RDAP (le remplaçant standardisé du WHOIS — gratuit, sans clé, réponse JSON). Sert de référence pour le module HTTP + Itérateur/Filtre à construire dans Make (scénario A, étape 4 du [cahier des charges](../docs/cahier-des-charges-technique.md)).

```bash
node scripts/test-rdap.js exemple.fr
```

Testé sur `.fr`, `.com`, `.net`, `.org` (fonctionnent) et `.de`, `.eu`, `.io` (pas de RDAP public — le script renvoie une erreur explicite plutôt que de planter). Un `User-Agent` de type navigateur/curl est nécessaire : Verisign (registre `.com`) renvoie 403 sans ça.

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
