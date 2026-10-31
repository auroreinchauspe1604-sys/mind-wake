# Atelier d’Aurore : clone local explicitement lié

Le panneau lit le clone de son workspace, avec l’origine exacte
`https://github.com/mind-protocol/scisense-aurore-workspace.git`.
Il n’appelle pas le MCP scoped et ne fait aucune opération réseau ou de synchronisation.

Le processus desktop doit recevoir `MIND_WAKE_DATA_DIR`. Sans cette variable, sans
`atelier-aurore.json` dans ce dossier ou avec `enabled` différent de `true`, la liaison
reste inactive. Après revue, l’opérateur peut créer ce fichier :

```json
{"enabled":true,"origin":"https://github.com/mind-protocol/scisense-aurore-workspace.git"}
```

Le seul emplacement accepté est alors
`<MIND_WAKE_DATA_DIR>/linked-workspaces/aurore-mind-protocol`.
Le fichier de liaison n’accepte aucun chemin, endpoint ou credential. Les paramètres
de la webview ne permettent pas de changer cet emplacement. Désactiver le fichier
prend effet à la requête suivante ; actualiser efface le document affiché.
La liaison ne peuple pas le dépôt et ne constitue pas une autorisation de publier.

Le lecteur valide une unique URL `remote.origin.url` dans la configuration Git locale,
exige un `.git` répertoire interne et refuse les liens/jonctions sur les chemins lus.
Il ne remplace pas les règles Git de propriété du dépôt (`safe.directory`).
Un échec d’accès ou un dépôt corrompu produit une erreur, sans repli.

États natifs : `not-configured`, `invalid-origin`, `empty` (version nulle pour branche
sans commit), `available` avec SHA du commit, `version-changed`, `error`.
Un commit existant sans documents compatibles produit `empty` avec sa SHA.
Le catalogue retient les blobs réguliers suivis, de chemin non caché, dont le fichier
existe encore dans le clone et passe la vérification de confinement. Les sous-modules
et liens Git sont exclus. Le contenu lu provient du blob commité, jamais des modifications
non commitées ou des fichiers non suivis. HTML/Markdown/TXT : 2 Mo ; raster : 8 Mo.
Le catalogue est limité à 10 000 documents ; les commandes Git ont un délai de 5 s et
une sortie maximale de 12 Mo. Aucun filtre Git de contenu n’est exécuté.

La SHA du catalogue accompagne les ouvertures et les images. Si HEAD a changé, le
lecteur exige une actualisation. Le contenu utilise le rendu, l’assainissement HTML,
la CSP et le décodeur raster existants. Le scope Aurore conserve son historique de
navigation et ses positions ; Next utilise son propre catalogue. Les noms d’Aurore
ne sont pas publiés dans le catalogue de conversation de l’humain. Les générations
de navigation rejettent les réponses d’un scope quitté, y compris après un aller-retour.

`artifacts/PERSONALITY.md` n’apparaît que s’il est effectivement présent et commité.
Le prompt complet généré sous `dataDir/runtimes/...` ne fait pas partie de ce clone
et n’est ni lu ni publié par ce panneau.

Vérification locale : `node --test services/shared-workspace/git-document-reader.test.mjs`,
tests `desktop/ui/document*.test.ts`, compilation TypeScript desktop et tests raster Rust.
Les fixtures sont artificielles et restent dans `output/scisense-raccord/fixtures`.
La compilation Tauri et la recette visuelle restent nécessaires avant installation.
