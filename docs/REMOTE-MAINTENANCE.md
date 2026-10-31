# Maintenance distante : tranche opt-in du 31 octobre 2026

Cette tranche fournit le diagnostic MCP de bout en bout et un contrôleur local
durable. Le superviseur desktop dispose maintenant d'un raccord opt-in pour
`relaunch_app` et `reinstall` (installation + app). Les cycles daemon et MCP restent
distincts et non pris en charge par ce raccord. Aucune installation distante n'est
activée par la présence du code.

## Raccord au superviseur installé

Sur la cible, après choix local des grants et du catalogue de releases, préparer
hors Git un fichier de liaison contenant `endpoint` et `key` du hub déjà autorisé.
La clé reste locale. Ne jamais la passer en argument de commande. Policy, liaison
et store doivent être protégés des racines partagées en écriture, idéalement dans
les données d'installation exclues par les scopes filesystem.

Configurer l'installation existante, sans démarrer ni reprendre le moteur :

```powershell
node scripts/setup-desktop-maintenance.mjs --manifest C:/pilot/installation/manifest.json --policy C:/pilot/maintenance-policy.json --binding C:/pilot/shared-binding.json --store C:/pilot/maintenance.sqlite
```

Cette commande conserve les champs du manifeste, le pairing et le workspace,
crée une sauvegarde et ne crée aucun grant. Relancer ensuite le panneau par son
lanceur installé `scripts/open-desktop.mjs` avec `MIND_WAKE_DATA_DIR` approprié.
Celui-ci utilise le superviseur existant et les options TypeScript du runtime.
Le démarrage direct du binaire desktop ne lance pas le contrôleur. Le hub doit
disposer du relais `--maintenance-relay` et le client de `MIND_WAKE_MAINTENANCE=1`.

Le superviseur relit la policy locale et vérifie l'identité authentifiée avant
chaque tick. Le hub hors ligne laisse l'app locale ouverte. Le contrôleur peut
diagnostiquer en Pause ; toute mutation est refusée pendant Pause/Force-off.
Il ne possède que l'app qu'il a lui-même lancée : aucun PID découvert, moteur,
MCP d'une autre session ou processus de l'utilisateur n'est arrêté.

Les builds nouveaux produisent après leur initialisation un reçu local avec
PID, nonce d'instance et révision compilée. Le superviseur confronte ce reçu à
son enfant et au hash de l'exécutable. Un ancien binaire sans reçu, un build
sale, ou un manifeste seul ne prouve jamais une révision chargée.

`reinstall` est annoncé uniquement pour une installation `development: false`
avec `updateSource` HTTPS explicite. Il réutilise `checkUpdate` et ses releases
immuables ; les commandes build tournent dans des Job Objects appartenant au
superviseur, annulables par les contrôles locaux. La garde est relue avant chaque
commande, avant le basculement du manifeste et avant le handoff app. Le catalogue
local doit approuver le commit complet ; le pair ne fournit ni URL ni shell.
Le résultat vérifie install + app ; les versions chargées daemon/MCP restent
inconnues et ne sont pas présentées comme mises à jour.

La recette filesystem de [SHARED-WORKSPACE.md](SHARED-WORKSPACE.md) reste le
complément pour le service de fichiers supervisé, le credential client et la
sonde list/read. Ces paramètres ne sont pas accordés par la maintenance.

## Transport et autorité

Le hub HTTPS existant reçoit, seulement avec `--maintenance-relay`, quatre
opérations typées : `maintenance_submit`, `maintenance_poll`,
`maintenance_publish`, `maintenance_get`. La clé du hub fournit l'acteur ; aucun
champ `from` n'est accepté. SQLite conserve requête et résultat séparément des
messages. Aucun corps de message ne passe dans le contrôleur, même s'il contient
le JSON exact d'une requête. Aucun modèle n'intervient dans cette boucle.

Le client shared stdio expose `request_maintenance` et `get_maintenance_result`
seulement avec `MIND_WAKE_MAINTENANCE=1`. Le défaut à cinq outils reste inchangé.
HTTPS, validation du certificat, limite de corps, admission et révocation des clés
du hub restent ceux du transport existant. La nouvelle file est bornée à 100
requêtes non terminales par acteur. Le hub transporte ; il n'autorise aucune
mutation sur le poste cible. La permission de messagerie ne vaut pas grant local.

Le propriétaire **du poste cible** prépare un fichier local, hors dépôt et non
modifiable par les outils de maintenance. Exemple documentaire, sans grant réel :

```json
{
  "target": "agent-bbbbbbbbbb",
  "sharedEndpoint": "https://hub.example.invalid/v1/messages",
  "grants": [{ "actor": "agent-aaaaaaaaaa", "actions": ["diagnose"] }],
  "releases": {}
}
```

Les pseudonymes doivent provenir des `whoami` réellement authentifiés du hub
convenu. Le contrôleur vérifie identité cible et endpoint. Supprimer un grant
interdit une action encore en file ; la relecture continue pendant l'exécution
annule le travail via `AbortSignal`. Le superviseur propriétaire doit aussi
arrêter ses enfants lors de Pause, Force-off, révocation ou arrêt. Aucun contrôle
ne reprend Wake, n'active une policy ou ne démarre de session. Les diagnostics
accordés peuvent être servis pendant Pause. Les données déjà retournées ne
peuvent pas être effacées du poste du pair par une révocation ultérieure.

## Diagnostic exécutable aujourd'hui

Depuis un clone avec ses dépendances existantes, lancer le récepteur une fois
dans le contexte local autorisé de la cible ; aucune installation ni service
n'est créé. Les deux variables du hub viennent de la configuration secrète locale
existante, sans clé en arguments ni journaux :

```powershell
node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./test/fixtures/store-ledger/ts-hooks.ts services/maintenance/controller-main.ts --policy C:/pilot/maintenance-policy.json --store C:/pilot/maintenance.sqlite --data-dir C:/pilot/wake-data --repo C:/pilot/wake-source --manifest C:/pilot/installation/manifest.json
```

Ce point d'entrée ne propose que `diagnose`. Il lit le vrai `wakeReader` et sa base
en lecture seule. Les états disabled/ready/running/checkpointing/hibernating/
paused/blocked/stopped sont conservés. Il retourne les pseudonymes, dates, état
Wake, Force-off et nombre de sessions ; le dernier état connu du daemon vient de
la lecture de statut existante. Les révisions source et installée restent
distinctes des révisions chargées. Sans reçu de démarrage des composants, les
révisions et hashes app/daemon/MCP restent `null`, même si Git ou le manifeste
désignent une version récente. Les erreurs exposées sont des codes de maintenance
assainis ; les erreurs runtime et leurs logs privés ne sont pas exportés.

L'émetteur crée un UUID et deux dates UTC avec TTL de 1 à 300 secondes (préférer
240 secondes), puis appelle :

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "target": "agent-bbbbbbbbbb",
  "action": "diagnose",
  "issuedAt": "2026-10-31T15:00:00.000Z",
  "expiresAt": "2026-10-31T15:04:00.000Z"
}
```

Les dates de cet exemple sont périmées : les créer à l'envoi. Réutiliser exactement
l'UUID et le corps après un timeout, puis consulter `get_maintenance_result`.
Une erreur de transport renvoie `delivery: unknown`, jamais un succès.
`relay_stored_target_unconfirmed` signifie que le hub conserve la requête sans
reçu cible. Cela ne prouve ni réception ni cible éteinte. `target_reported` et
l'état accepté/en cours/redémarrage en attente prouvent une étape ultérieure,
pas un succès. Un résultat terminal perdu se republie depuis le journal cible.
Il n'existe pas encore de heartbeat permettant de déclarer une cible injoignable
avec certitude ; absence de résultat et action sans retour restent incertaines.

## Adapters de maintenance

`LocalMaintenanceAdapter` accepte uniquement des dépendances locales de confiance.
Le pair fournit un enum et un identifiant de release, jamais commande, chemin,
URL, clé ou argument de processus. Le catalogue local associe par exemple
`approved` à `{ "revision": "<commit complet approuvé>" }`.

| Action            | Implémentation et preuve                                                                                               | Disponibilité par défaut                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `diagnose`        | Vrai lecteur Wake, sans modèle, MCP/HTTPS/SQLite/processus cible testés                                                | Oui, avec grant                                        |
| `pull_source`     | Helper Git supervisé existant, racine/branche/origin locaux vérifiés, fetch puis commit approuvé et merge fast-forward | Seulement si source locale configurée                  |
| `relaunch_app`    | Handoff vers `OwnedLifecycle`, nouvelle instance et révision chargée exigées                                           | Indisponible sans propriétaire branché                 |
| `relaunch_mcp`    | Même contrat ; aucun MCP lancé par un hôte externe n'est tué                                                           | Indisponible sans propriétaire branché                 |
| `relaunch_engine` | Même contrat ; pas de daemon de secours détaché                                                                        | Indisponible sans propriétaire branché                 |
| `reinstall`       | Callback local vers `checkUpdate`, fetch/build/release immuable avant handoff app, révision attendue exigée            | Indisponible sans updater supervisé + propriétaire app |

Le pull refuse les modifications locales, une branche/origin différente, une
révision non approuvée ou une divergence. Il n'exécute aucun reset/force/clean/
stash et ne pousse rien. Codes explicites : `source_dirty`, `source_diverged`,
`source_mismatch`, `revision_mismatch`. Il ne modifie pas la configuration live.

`checkUpdate` conserve son comportement desktop et ajoute `expectedRevision` et
`beforeStep`. Le branchement de maintenance doit lui fournir un runner possédé
par le superviseur existant, interruptible par `AbortSignal`, vérifier le code
`installed/current` et la révision retournée, puis effectuer le handoff. Le guard
est appelé avant chaque commande et avant le basculement du manifeste. Le défaut
non supervisé de l'updater desktop n'est pas un branchement distant autorisé.
La provenance source HTTPS doit être choisie localement, jamais par le pair.
Le téléchargement d'un artefact binaire HTTPS/hash n'est pas implémenté ici.

SQLite réserve une opération active au plus et conserve les UUID, y compris les
refus. Le verrou d'instance SQLite existant est libéré par l'OS après mort du
processus. Une seconde exécution ne réconcilie pas un handoff encore vivant.
Une courte garde de dix secondes limite les mutations répétées après succès ou
échec. `restart_pending` est persisté avant le handoff ; après interruption on
observe le composant, sans répéter la commande. `running` interrompu échoue
explicitement. Pas de succès déduit d'exit0. Le superviseur doit rendre le nouveau
composant joignable avant de rendre la main : aucun retry de restart automatique.

Chaque résultat précise `verificationScope` et `versionComparison` par composant.
La preuve de réinstallation de cette tranche porte sur **install + app**. Elle
ne certifie pas que daemon et MCP sont à jour ; leurs écarts/inconnues restent
visibles dans le même résultat. Une mise à jour complète devra composer leurs
handoffs possédés et vérifier les trois versions chargées.

## Recette deux postes, après revue et intégration séparées

1. Les deux propriétaires choisissent le hub existant et vérifient chacun leur
   identité. L'opérateur active explicitement le relais dans ce hub ; aucune
   adresse publique ni tunnel supplémentaire n'est nécessaire dans le code.
2. La cible accorde localement `diagnose` au seul pseudonyme convenu, lié à cet
   endpoint. Le sender active les deux outils supplémentaires. Aucune copie des
   permissions NLR, des clés ou des identités du poste NLR vers l'autre poste.
3. Émettre un diagnostic frais, constater d'abord stockage hub puis réponse du
   contrôleur one-shot ci-dessus ; comparer état Wake et versions avec la cible.
   Faire l'essai en Pause sans démarrer de modèle. En l'absence de contrôleur
   joignable, préparer son intégration initiale sur la cible ; aucun lancement
   magique depuis une machine éteinte n'est possible.
4. Avant de conférer des actions mutantes, brancher le pump et les callbacks dans
   **le superviseur existant**. App : utiliser son handoff de restart explicite
   (le supervisor desktop reconnaît déjà exit75). Engine : arrêt/handoff possédé
   sans appeler `on`/`reactivate`. MCP : seulement les enfants dont Wake est le
   propriétaire, pas une session Codex/Claude ou un MCP externe.
5. Obtenir les reçus de version intégrés au démarrage de chaque composant, relier
   liveness et identité d'instance, puis autoriser les enums nécessaires et une
   release revue. Tester update avant relaunch, refus d'une source sale, Pause
   pendant build et juste avant handoff, arrêt humain, perte de retour et reprise.
6. Ne déclarer le poste à jour qu'après comparaison des trois composants chargés.
   Révoquer le grant et vérifier le refus de la requête suivante.

## Validation locale et suite

`test/maintenance` traverse le vrai MCP stdio, TLS loopback, SQLite, la CLI de
contrôleur, le helper app-update et les Job Objects du superviseur existant. Les
builds d'installation sont une **toolchain miniature de fixture**, avec vrais
Git/Node et un composant Node réellement relancé ; le fichier `.exe` attendu par
l'updater est un marqueur de fixture, pas une app Windows compilée. Les états Wake
mutants sont des fixtures explicites. Le test de reprise fait sortir réellement
le contrôleur pendant le handoff, puis le redémarre et constate un seul handoff.
Ce ne sont ni un build release de Wake ni un essai sur Silas ou Aurore.

Le raccord desktop ci-dessus ajoute le pump et les reçus app au superviseur
existant. Les tests `desktop-owner.node.mjs` et `desktop-supervisor.process.test.ts`
exercent de vrais processus Node de fixture, la relance et le transport HTTPS ;
ils ne constituent pas un essai du binaire Windows sur le poste d'Aurore.
Prochaine tâche : produire les reçus daemon/MCP dans leurs propriétaires respectifs,
puis exécuter la recette deux postes avec les grants du propriétaire cible. Le bootstrap client
shared à quatre modules ne distribue pas encore ces nouveaux modules : lancer
depuis le clone complet pour la recette actuelle. Pas d'UI de grants, de mode
offline/outbox sender, de heartbeat cible, de rétention automatique, de rollback
après migration ni de mise à jour depuis artefact binaire dans cette tranche.
