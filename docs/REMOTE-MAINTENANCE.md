# Maintenance distante : tranche opt-in du 31 octobre 2026

Cette tranche fournit le diagnostic MCP de bout en bout et un contrôleur local
durable. Le superviseur desktop dispose maintenant d'un raccord opt-in pour
`relaunch_app`, `relaunch_engine`, `relaunch_mcp` et `reinstall`. Les composants Node
ont leurs propres lanceurs locaux ; le panneau les contacte par IPC authentifié.
Aucune installation distante n'est
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
Il possède l'app qu'il a lancée et peut demander au propriétaire du moteur ou
d'un worker MCP MIND de remplacer son enfant. Aucun PID découvert, autre MCP du
fournisseur ou processus de l'utilisateur n'est adopté ni arrêté.

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
Le résultat vérifie install + app et chaque composant moteur/MCP possédé qui était
actif avant l'opération. Il refuse le succès si l'un de ces composants garde son
ancienne instance ou ne charge pas le commit attendu. Un composant sans
propriétaire ou sans reçu reste inconnu ; il n'est pas présenté comme mis à jour.

### Propriétaires moteur et MCP

`engine-supervisor.mjs` est utilisé par les nouveaux démarrages du moteur depuis
le panneau ou le lancement Windows. Il survit à la fermeture du panneau, garde
le contrôle de son seul enfant et attend son arrêt propre via IPC avant de le
recréer depuis le manifeste actuel. Il ne lève ni Pause ni Force-off.
Son enfant et ses descendants restent dans un Job Object possédé par ce lanceur ;
la disparition du propriétaire ferme aussi cette arborescence. L'arrêt normal
transmet une commande JSON sur le stdin privé du moteur, puis attend sa fermeture.

Le lanceur agent `start-local.mjs` utilise `owned-mcp.mjs`. Ce proxy conserve la
connexion stdio du fournisseur, renvoie une erreur aux requêtes interrompues,
réinitialise le nouveau worker MIND puis traite les nouvelles requêtes. Les autres
serveurs MCP configurés dans Codex/Claude ne sont pas concernés. Un client encore
non initialisé ne peut pas être relancé. Les anciennes installations doivent
effectivement démarrer ces nouveaux lanceurs pour exposer ces capacités.

Pour rattacher également le MCP de messages partagés au même propriétaire Wake,
`setup-shared-messages.mjs` accepte `--wake-manifest CHEMIN_ABSOLU`. Le fragment
produit emploie alors `owned-shared-mcp.mjs`, conserve l'identité existante et
recharge la source sélectionnée par le manifeste après chaque relance. Sans cette
option, le bootstrap indépendant à quatre modules conserve son fonctionnement.

`npm run build` génère `dist/runtime-build.json` : révision, propreté de la source
et hashes des modules Node distribués. Le moteur après enregistrement de son
démarrage, et le MCP après connexion de son transport, émettent un reçu local.
Un stamp absent, sale ou ne correspondant plus aux dépendances donne une version
chargée inconnue, même si Git HEAD ou le manifeste semblent récents.
Le lanceur MCP géré par l'installation relit désormais le manifeste à chaque
démarrage. L'updater migre l'ancien lanceur standard vers ce format sans changer
la configuration du fournisseur ni écraser un lanceur personnalisé.

Le diagnostic inclut aussi `health` : nombre d'événements observés, échecs runtime,
date du dernier échec, dernier résultat de session, et dates réception/émission/
publication du canal propriétaire. Aucun texte de conversation ni erreur privée
brute n'est transmis.

### Commande client prête à utiliser

Depuis le clone complet, la même opération que les outils MCP est disponible :

```powershell
node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./test/fixtures/store-ledger/ts-hooks.ts scripts/maintenance-client.mjs --binding C:/private/shared-binding.json --target agent-bbbbbbbbbb --action reinstall --release stable --wait
```

Le catalogue `stable` appartient à la policy locale cible et désigne le commit
approuvé. La requête est sauvegardée à côté du binding avant envoi. Un nouvel appel
avec le même `--request-id` réutilise exactement son corps et ses dates ; un timeout
ne déclenche pas une nouvelle commande. Pour consulter sans soumettre : remplacer
les options cible/action/release par `--result UUID`. Code de sortie 0 signifie
résultat vérifié, 1 refus/échec/transport inconnu, 2 résultat encore non terminal.

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
| `relaunch_app`    | Handoff vers `OwnedLifecycle`, nouvelle instance et révision chargée exigées                                           | Propriétaire app du superviseur desktop                |
| `relaunch_mcp`    | Proxy stdio possédé, réinitialisation du worker MIND et nouveau reçu exigés                                            | Disponible pour les nouveaux lanceurs MCP MIND         |
| `relaunch_engine` | Handoff du lanceur moteur indépendant du panneau, arrêt propre et nouveau reçu exigés                                  | Disponible pour les moteurs lancés par le propriétaire |
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
La vérification de réinstallation porte sur **install + app** et les propriétaires
moteur/MCP qui étaient actifs avant le handoff. Ces composants doivent tous changer
d'instance et charger le commit attendu. Les composants sans propriétaire restent
inconnus ; `verificationScope` indique exactement ceux qui ont été vérifiés.

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
Les reçus daemon/MCP sont maintenant produits par leurs composants et vérifiés
par leurs propriétaires. Les essais `owned-runtimes.node.mjs` incluent un vrai
client MCP conservé à travers une relance, un moteur de fixture avec arrêt IPC,
et la détection d'une dépendance modifiée après build. Prochaine étape : publier
la release et exécuter la recette deux postes avec les paramètres et grants cibles.
Le bootstrap client
shared à quatre modules ne distribue pas encore ces nouveaux modules : lancer
depuis le clone complet pour la recette actuelle. Pas d'UI de grants, de mode
offline/outbox sender, de heartbeat cible, de rétention automatique, de rollback
après migration ni de mise à jour depuis artefact binaire dans cette tranche.
