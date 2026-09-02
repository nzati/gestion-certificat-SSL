# Scripts de mise en place

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
