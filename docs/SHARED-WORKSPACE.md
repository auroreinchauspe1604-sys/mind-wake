# Shared workspace — scopes directs MCP supervisés et transport legacy

## Lot scoped MCP (31 octobre 2026) : développement synthétique, sans activation

`workspace.mjs` conserve le moteur existant et ajoute `localGrantScope`,
`createScopedWorkspaceSession` et `localRestoreOperation`. Le client stdio
`mcp-scoped.mjs` utilise les sept outils de `scoped-mcp.mjs` et le même transport
HTTPS, sur la route distincte `/v1/scoped-workspace`. `scoped-job.mjs` sert cette
route dans un job supervisé Wake. Aucun dossier réel, credential utilisateur ou
service utilisateur n'est activé. Le miroir Git reste un chantier distinct ; aucun moteur de synchronisation
n'est ajouté ici. Le mode direct est accepté ; sa mise en service dépend des choix
concrets ci-dessous, pas d'une nouvelle approbation abstraite du mode.

### Autorité locale et droits

Seul le propriétaire ou son agent dans sa délégation locale appelle `scope-grant`
ou `revoke`. Ces commandes ne sont jamais des outils destinataire. Aucun message
reçu, contenu de fichier ou paramètre MCP ne peut sélectionner une racine, changer
de destinataire ou augmenter les droits. Les autorisations personnelles du dépôt
ne sont pas copiées dans les autres installations.

Chaque grant nomme un scope (`name`, ASCII lettres/chiffres/`_`/`-`, 1–80), une
racine absolue existante canonicalisée et un participant. Deux scopes de noms
différents ne peuvent ni se recouvrir ni partager une racine ; un même nom reste
attaché à sa racine, même après révocation. Plusieurs destinataires peuvent avoir
des capacités distinctes sur le même scope. Le porteur du token est lié au
participant et à la capacité ; cela ne prouve pas une identité physique.

| Droit explicite | Opération et conditions                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `list`          | Liste bornée de métadonnées, sans contenu                                                      |
| `search`        | Recherche littérale de noms ou contenus, avec courts extraits                                  |
| `read`          | Lecture UTF-8 avec SHA-256                                                                     |
| `create`        | Création d'un fichier absent ; parent existant requis                                          |
| `write`         | Remplacement d'un fichier existant, SHA-256 attendu requis                                     |
| `delete`        | Suppression réversible, SHA-256 attendu requis                                                 |
| `propose`       | Voie historique de proposition de remplacement ; requiert aussi `read` pour examen/application |

`list/search/read/create/write/delete` sont indépendants : un droit de mutation
n'accorde pas lecture ou recherche. `search` autorise explicitement ses extraits.
Les anciens grants version 1 restent `read` ou `read,propose`, avec leur liste
historique ; ils ne gagnent ni recherche ni CRUD direct. Les grants nommés sont
refusés par l'ancienne façade HTTPS, afin d'éviter ses droits implicites. Les MCP
local/distant historiques restent inchangés.

Exemple de forme **à adapter localement**, sans lancement de service :

```powershell
node services/shared-workspace/cli.mjs scope-grant --state 'D:\Prive\scopes.json' --name projet --root 'D:\ProjetChoisi' --participant destinataire --rights list,search,read,create,write,delete --credential 'D:\Prive\destinataire.json'
node services/shared-workspace/cli.mjs revoke --state 'D:\Prive\scopes.json' --capability 'ID'
node services/shared-workspace/cli.mjs scope-restore --state 'D:\Prive\scopes.json' --operation 'ID-OPERATION' --expected-hash 'SHA256-APRES'
# Après delete, --expected-hash absent exige que le fichier soit toujours absent.
```

État, verrou, snapshots et credentials restent hors de **tous** les scopes, hors Git
et protégés par les ACL locales. La CLI refuse un credential sous une racine déjà
déclarée. Ne pas sélectionner ensuite une racine contenant des credentials
existants ; la sélection locale reste responsable d'un dossier sans secrets.
La CLI de récupération est locale et utilisable même après révocation.

### Recherche et mutations

`workspace_search {path?, query, mode?}` parcourt seulement le scope, sans shell,
regex exécutable ou index global. `mode` vaut `name` (défaut) ou `content` ; query
contient 1–200 caractères. Maximum : 1 000 entrées inspectées, 100 résultats,
profondeur 16, budget conservateur de lectures 2 Mio (128 Kio réservés par fichier),
5 secondes vérifiées entre lectures. Un extrait contient au plus 160 caractères,
avec numéro de ligne et `snippetTruncated`. `truncated`, `reasons`, `scanned` et
`budgetedBytes` rendent les omissions/limites visibles. Un résultat vide tronqué
ne prouve pas une absence. Les limites de fichiers et chemins historiques restent
applicables : pas de binaire, symlink/junction, hardlink, absolu, traversal ou ADS.

Chaque mutation exige une clé d'idempotence stable et conserve au plus 64 opérations
dans l'état privé. Même clé et contenu différent : `idempotency_conflict` ; hash
périmé ou create sur fichier présent : `hash_conflict`. Un replay terminal retourne
l'opération historique sans réécrire le disque. Les snapshots avant/après disponibles
sont durables avant l'intention `prepared` ; suppression = retrait du fichier choisi
avec original conservé dans `<state>.private/<id>.before`. Write utilise un
temporaire puis rename, create une ouverture exclusive. La restauration vérifie le
hash réel attendu (ou l'absence), les snapshots et le résultat relu ; elle préserve
les octets UTF-8, BOM et fins de ligne. Elle ne réactive aucune capacité.

Les intentions `prepared/restoring` se réconcilient avec le disque au replay ou à
la restauration : terminé, étape à reprendre ou conflit. Il n'y a pas de transaction
OS multi-fichiers ni CAS atomique. Un crash pendant la création exclusive peut
laisser un fichier partiel : conflit conservé, snapshots disponibles pour examen
et récupération locale manuelle ; aucune réécriture automatique d'un conflit.
Un verrou abandonné doit être examiné après arrêt des opérateurs. Un refus ACL,
un fichier Windows verrouillé ou un snapshot endommagé reste un échec explicite.

Les noms courants de credentials et dossiers de contrôle sont exclus ; les noms
métier tels que `token-economy.md` restent accessibles. Le scoped adapter refuse
les contenus présentant des signatures courantes de secrets (clé privée, token,
affectation de mot de passe/API key), sans renvoyer leur corps ou une erreur brute.
Cette défense ne peut classifier tout secret arbitraire : sélectionner des racines
préparées sans secrets. Les données retournées sont non fiables ; elles ne sont
jamais évaluées. Les réserves TOCTOU/reparse points/ACL ci-dessous restent valables.

### Cycle de vie livré

Le helper local `scripts/setup-scoped-workspace-job.mjs` crée un script neuf sous
`workspace/jobs/`, qui importe le serveur depuis ce clone dans son propre processus.
Il ne démarre rien et ne touche aucune configuration existante. L'entrypoint exige
les marqueurs `MIND_WAKE_JOB_ID` et `MIND_WAKE_JOB_OUTPUT`. Ces marqueurs sont des
guards d'usage, pas une preuve cryptographique de supervision : lancer réellement
le script avec `start_background_job`, dans le mode hôte déjà autorisé.

Le daemon possède alors worker et serveur via `BackgroundJobs` et le Job Object
Windows existant, sans spawn détaché ni relance automatique. Pause retire l'accord
du predicate existant ; annulation, Force-off (`terminateBackgroundJobs`), arrêt du
daemon et fermeture du Job Object terminent l'arbre et donc les sockets OS.
Les contrôles planifiés sont relus toutes les 500 ms ; ce délai n'est pas nul.
Les jobs interrompus ne sont pas rejoués après reprise ; nouvelle soumission et
clé d'idempotence nécessaires. Une session IA terminée laisse le job continuer,
conformément au contrat Background Jobs ; la fin du **job** ferme son service.

Pour l'arrêt coopératif, SIGINT/SIGTERM déclenchent abort, refus des nouveaux
appels, fermeture du listener et destruction de toutes les connexions, y compris
les handshakes incomplets. Sous Windows, la terminaison forcée ne délivre pas
nécessairement les handlers JS : le Job Object reste l'autorité d'arrêt.
L'authentification token/capacité/participant est vérifiée avant et après upload,
puis par la session à chaque opération ; les grants legacy sont refusés sur cette
route et les named grants restent refusés sur la route legacy.

Un arrêt n'annule jamais rétroactivement une mutation synchrone achevée. L'event
loop ne préempte pas une opération fichier synchrone ; une terminaison forcée peut
interrompre sa persistance. Les snapshots/intents et les limites de récupération
décrites plus haut restent applicables. Aucune transaction distribuée n'est ajoutée.

### Recette unique cible → TLS privé → client natif → diagnostic

Paramètres manquants : racine/nom/droits choisis, participant convenu, adresse IP
privée **déjà joignable** du poste propriétaire, port réservé et certificat serveur
valide dont le SAN couvre exactement cette IP, clé privée correspondante et CA
approuvée par le destinataire. Cette recette utilise directement cette liaison
privée existante en HTTPS ; aucun tunnel, route ou firewall n'est créé par le helper.
Sans cette adresse et ces fichiers TLS, la validation inter-postes reste ouverte.
Les commandes ci-dessous sont une recette, pas une activation effectuée par ce lot.
Le client et le preflight acceptent une IP littérale loopback, RFC1918 ou IPv6 ULA
(pas de résolution DNS, URL publique, redirection ou TLS désactivé). Un transport
privé absent donne `private_transport_required` ; une IP privée configurée mais
non joignable donne `inaccessible` à la sonde. Le programme ne sait pas déterminer
si la cause est une route, un pare-feu ou un service arrêté. Aucun scan n'est fait.

Prérequis sur chaque poste : clone contenant ces fichiers et `package-lock.json`,
Node 24.17+ dans la branche 24 ou 26.13+ dans la branche 26, dépendances installées
par `npm.cmd ci` par l'opérateur. Les `.mjs` s'exécutent directement, sans build
TypeScript/Cargo ni changement du moteur live. Le clone doit rester à son chemin
après installation : le fragment MCP et le script job y font référence.

Sur le propriétaire, définir `$private` hors Git et hors toutes les racines
partagées, `$workspace` vers son espace Wake, `$root` vers la racine choisie et
`$dataDir` vers les données de son installation. Placer `server-key.pem`,
`server-cert.pem` et `ca.pem` dans `$private`, sous ACL du compte propriétaire.
Fixer `$ownerIp` à l'IP convenue, `$port` au port réservé et `$participant` à
l'identifiant convenu. Choisir aussi `$scope`, `$rights` et `$probe` : nom ASCII
du scope, droits explicitement choisis, chemin relatif `/` d'un petit fichier
texte existant autorisé à la lecture. Pour ce diagnostic, `list,read` suffisent ;
aucun droit d'écriture n'est nécessaire. Ne pas créer un fichier sur la cible
pour les besoins de la sonde. La sélection et le grant ci-dessous sont effectués
sur la cible par son opérateur autorisé ; ce worker ne les exécute pas. Depuis le clone :

```powershell
$state = Join-Path $private 'scopes.json'
$credential = Join-Path $private 'recipient.json'
$endpoint = "https://${ownerIp}:$port/v1/scoped-workspace"
node services/shared-workspace/cli.mjs scope-grant --state $state --root $root --name $scope --participant $participant --rights $rights --data-root $dataDir --credential $credential --endpoint $endpoint --ca (Join-Path $private 'ca.pem')
if ($LASTEXITCODE -ne 0) { throw 'Grant local refuse ; ne pas continuer' }
$config = Join-Path $private 'scoped-server.json'
$json = @{stateFile=$state; keyFile=(Join-Path $private 'server-key.pem'); certFile=(Join-Path $private 'server-cert.pem'); host=$ownerIp; port=[int]$port} | ConvertTo-Json
[IO.File]::WriteAllText($config, $json, [Text.UTF8Encoding]::new($false))
node services/shared-workspace/cli.mjs scope-preflight --config $config
if ($LASTEXITCODE -ne 0) { throw 'Preflight cible refuse ; aucun service demarre' }
node scripts/setup-scoped-workspace-job.mjs --workspace $workspace --config $config
if ($LASTEXITCODE -ne 0) { throw 'Preparation job refusee' }
```

Soumettre ensuite via le MCP Wake local :
`start_background_job {title:"Scoped workspace",script:"jobs/serve-scoped-workspace.mjs",args:[],idempotency_key:"scoped-projet-activation-1"}`.
Lire `list_background_jobs` et `jobs/runs/<id>/scoped-ready.json` ; un job en file
n'est pas une écoute. Le helper refuse d'écraser un script existant et le serveur
refuse config/état/clé/certificat sous une racine retenue, même révoquée, ou dans Git.
La CLI scope-grant refuse état et credential dans Git ; une définition locale sans
endpoint reste possible, mais le credential doit avoir endpoint et caFile pour le client.

Transmettre **seulement** `recipient.json` et `ca.pem` via le canal déjà autorisé.
Sur le destinataire, les conserver hors Git dans son dossier privé ; adapter
uniquement `caFile` dans sa copie du credential au chemin absolu local de `ca.pem`.
Ne jamais transmettre état, snapshots, config serveur ou clé privée. Depuis son clone :

```powershell
$fragment = Join-Path $private 'workspace-scoped.toml'
node scripts/setup-shared-workspace.mjs --role scoped --credential $credential --output $fragment
if ($LASTEXITCODE -ne 0) { throw 'Configuration client refusee' }
node services/shared-workspace/cli.mjs scope-diagnose --credential $credential --scope $scope --probe $probe
if ($LASTEXITCODE -ne 0) { throw 'Sonde refusee ; examiner statut/etape/raison JSON' }
```

La sonde utilise `callScopedWorkspace`, le même client HTTPS que le MCP. Elle fait
`list` à la racine puis `read` du seul fichier désigné, en exigeant le nom de scope
sur les deux requêtes. La réponse contient le scope renvoyé par le serveur, le
participant, la capability, le certificat SHA-256 de la connexion TLS vérifiée,
le nombre d'entrées et le hash/octet de la sonde. Aucun contenu ni nom de fichier
listé n'est journalisé. Ces données ne prouvent pas une identité physique Aurore.

| Statut JSON              | Interprétation                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `not_configured`         | Credential/CA absents ou invalides, mauvaise route, transport privé ou scope/sonde explicites manquants                                    |
| `inaccessible`           | Connexion refusée/interrompue, réseau inaccessible ou délai dépassé                                                                        |
| `tls_refused`            | Certificat non approuvé, nom incorrect ou autre refus TLS                                                                                  |
| `auth_refused`           | Token/identité incorrects **ou** capability inactive/révoquée ; le serveur ne distingue pas ces causes                                     |
| `scope_refused`          | Identité acceptée, mais scope ou droit list/read refusé                                                                                    |
| `operation_refused`      | Lecture ou protocole refusé ; voir raison assainie et étape list/read                                                                      |
| `read_succeeded`         | Liste et lecture vérifiées pour cette configuration uniquement ; `remoteAccessVerified:false` sans attestation du trajet entre deux postes |
| `fixture_read_succeeded` | Option `--fixture` : preuve synthétique seulement, jamais un accès Aurore                                                                  |

Les refus ont un exit code 1, les lectures réussies 0. Sans credential local,
`scope-diagnose` ne fait aucune requête et renvoie `not_configured`.

Pour le raccord natif, `$native` est le chemin absolu de la configuration TOML
du runtime **choisi localement**. Préparer un candidat neuf hors Git :

```powershell
$candidate = Join-Path $private 'native-with-scoped.toml'
$baseHash = (Get-FileHash -LiteralPath $native -Algorithm SHA256).Hash
node scripts/setup-shared-workspace.mjs --role scoped --credential $credential --base-config $native --output $candidate
if ($LASTEXITCODE -ne 0) { throw 'Candidat refuse ; ne pas remplacer la config native' }
```

Le candidat conserve tous les octets de la config existante puis ajoute exactement
le fragment. Toute occurrence du nom du serveur scoped existant est refusée par
précaution (y compris un commentaire). Aucun fichier existant n'est écrasé ; le
helper ne modifie ni la config live, ni les permissions, ni les autres serveurs.
Le candidat peut contenir les secrets d'autres serveurs : conserver les mêmes ACL
privées, ne pas l'envoyer ni le publier. Le fragment seul ne contient aucun token.

Après revue du candidat, l'intégrateur autorisé peut l'installer (commandes non
exécutées par ce lot), puis ouvrir une **nouvelle session** du runtime choisi :

```powershell
if ((Get-FileHash -LiteralPath $native -Algorithm SHA256).Hash -ne $baseHash) { throw 'Config modifiee depuis preparation ; regenerer le candidat' }
$backup = Join-Path $private 'native-before-scoped.toml'
if (Test-Path -LiteralPath $backup) { throw 'Choisir un backup neuf' }
Copy-Item -LiteralPath $native -Destination $backup -ErrorAction Stop
Copy-Item -LiteralPath $candidate -Destination $native -ErrorAction Stop
```

Vérifier dans cette nouvelle session les autres serveurs et les sept outils
`workspace_list/search/read/create/write/delete/propose`, puis appeler
`workspace_list {path:""}` et `workspace_read {path:$probe}`. La découverte ne
prouve aucun droit d'écriture : chaque appel reste soumis au grant cible. Aucun
rôle `local` ne doit être ajouté au destinataire. Rollback client : fermer cette
session puis `Copy-Item -LiteralPath $backup -Destination $native -ErrorAction Stop`
**si la config n'a pas changé entre-temps** ; sinon retirer seulement la section
ajoutée après revue pour préserver les nouvelles modifications. Réouvrir une session.
Supprimer un fragment/credential ne révoque pas les copies du token.

Rollback cible : `revoke --state $state --capability IDENTIFIANT` sur la cible,
puis `cancel_background_job` du job exact (ou Pause/Force-off). Vérifier le refus
de la sonde et la fin du job. Supprimer le seul script préparé après arrêt si
souhaité ; conserver l'état nécessaire à l'audit. Aucun
reconnecteur automatique n'est installé ; un client encore ouvert après arrêt du
serveur échoue et ne redémarre pas le serveur. Ne pas activer l'ancien `serve`
manuel pour ce mode. Les interfaces desktop ne sont pas modifiées par ce lot.

### Vérification réseau synthétique du lot

```powershell
node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./test/fixtures/store-ledger/ts-hooks.ts --test services/shared-workspace/transport.test.mjs services/shared-workspace/mcp.test.mjs services/shared-workspace/scoped.test.mjs services/shared-workspace/scoped-transport.test.mjs
```

La suite ajoute un diagnostic CLI sur fixture supervisée et un lancement MCP
depuis le fragment réellement généré ; elle vérifie aussi le candidat natif
additif, les statuts de refus et l'absence de contenu/secret dans ses sorties.
Les résultats exécutés du lot client figurent dans `output/aurore-filesystem-client/verification.json`.
Les essais tournent sous Windows/Node 24.17, sans garde réseau artificielle,
avec certificats éphémères locaux et listeners loopback. La nouvelle suite importe
les sources TypeScript du superviseur avec les hooks de test existants, sans build
Cargo ni daemon réel redémarré. Elle lance deux vrais processus MCP stdio, un vrai
serveur TLS dans `BackgroundJobs`/Job Object, puis vérifie CRUD/hash périmé,
proposition, identité liée au token, refus legacy/named croisés, CA non approuvée,
révocation pendant upload et récupération après révocation. Elle vérifie les PID
serveur absents et ports fermés après predicate Pause, emergency Force-off,
annulation, fin normale et fermeture du manager, puis absence de replay avec un
nouveau manager. Un autre essai vérifie abort et socket de handshake inachevé, puis
SIGTERM d'un processus serveur. Les boutons desktop et le trajet entre deux postes
réels ne sont pas exercés ; ce sont des processus et installations synthétiques
sur le même poste. La garde historique sans réseau reste disponible pour les seuls
tests mémoire, mais ne doit pas être appliquée à ces suites TLS.

## Transport historique v0.2 (inchangé, activation manuelle distincte)

Ce composant Node 24.17 expose `POST /v1/workspace` en HTTPS et deux rôles MCP stdio distincts. Il est séparé du hub de messagerie et de ses cinq outils ; aucun message reçu ne devient une opération fichier. Il ne dépend ni du daemon, ni de SQLite, ni du desktop. Aucun dossier ni capacité n'existe par défaut. Le service écoute **uniquement 127.0.0.1**. Il n'ouvre aucun accès depuis Internet et ne crée aucun tunnel.

État livré et testé : liste/lecture distante, propositions persistantes et dédupliquées, puis examen/application/rejet/restauration par l'agent **local**, avec sauvegarde et relecture du fichier réel. Le client distant reste limité à list/read/propose : `apply`, suppression, shell et création de droits par HTTPS sont refusés. Une proposition est une donnée non fiable, **ni une instruction ni une autorisation** ; seul l'agent local peut décider de l'appliquer dans son mandat d'édition déjà accordé. Aucun traitement automatique de la file n'est installé.

## Installation opérateur (après choix explicite du propriétaire)

Depuis le clone et ses dépendances actuelles (`npm ci` effectué par l'opérateur), lancer les `.mjs` sans build. MCP utilise `@modelcontextprotocol/server` et `zod` déjà présents ; la CLI/HTTPS seule reste en Node natif. Ne pas intégrer silencieusement dans le moteur a76 ni dans les cinq outils messages. La compatibilité testée est Node 24.17 ; aucun essai sur le poste d'Aurore ni distribution publiée n'est attesté.

Le propriétaire choisit un petit projet sans secrets, puis le participant et les droits. Une sélection dans une config préparée par un tiers ne prouve pas son consentement. Le fichier de capacité client ne doit être créé/transmis qu'après ce choix. La v0 permet `read` ou `read + propose`, jamais `write`. Aucun token destiné à Aurore n'est précréé.

Un projet dans AppData est possible : déclarer localement le **véritable dossier de données** avec `--data-root`, puis choisir `--root` égal à son `workspace` ou à un sous-dossier de celui-ci. Exemple de forme uniquement : `--data-root 'C:\Users\Compte\AppData\Local\InstallationChoisie' --root 'C:\Users\Compte\AppData\Local\InstallationChoisie\workspace\ProjetChoisi'`. Aucun compte ni nom d'installation particulier n'est reconnu comme autorisation. `MIND_WAKE_DATA_DIR` et le défaut `%LOCALAPPDATA%\mind-wake` sont aussi pris en compte comme racines de contrôle ; `--data-root` peut être répété pour les installations personnalisées. Déclarer une racine de données ne crée aucune capacité : la sélection `--root` et l'action locale `grant` restent nécessaires. La déclaration doit refléter l'installation réelle ; elle n'est jamais acceptée depuis une requête distante.

AppData, Local/Roaming/LocalLow, les racines de données connues et leurs parents restent non sélectionnables. Sous une racine déclarée, seul le workspace peut être partagé : fichiers de contrôle/configuration et clés restés à côté du workspace n'en font pas partie. Les autres arbres AppData restent fermés sans déclaration locale appropriée. Les chemins `runtime`, `runtimes`, `installation`, `auth`, `profiles`, `credentials`, `secrets`, `codex-home`, `claude-home` et les composants cachés du workspace sont refusés, à la sélection et à la lecture. Choisir un dossier plus petit que le workspace reste préférable pour limiter les informations partagées.

Exemple PowerShell **à adapter et exécuter par l'opérateur autorisé**, depuis le dossier distribué :

```powershell
$private = Join-Path $env:LOCALAPPDATA 'MindWakeSharedWorkspace'
New-Item -ItemType Directory -Force $private
# Restreindre les ACL Windows de ce dossier au propriétaire avant de créer les clés.
# Les modes POSIX 0700/0600 du programme ne remplacent pas les ACL Windows.
$cli = '.\services\shared-workspace\cli.mjs'
$state = Join-Path $private 'grants.json'
$key = Join-Path $private 'server-key.pem'
$cert = Join-Path $private 'server-cert.pem'
$credential = Join-Path $private 'marco-capability.json'
# Fournir un certificat TLS approuvé et sa clé, hors Git.
# Pour un essai LOCAL seulement, OpenSSL peut créer un certificat temporaire :
openssl req -x509 -newkey rsa:2048 -nodes -keyout $key -out $cert -days 1 -subj '/CN=localhost' -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost'
node $cli grant --state $state --root 'D:\ProjetChoisi' --participant marco --credential $credential --endpoint 'https://127.0.0.1:9447/v1/workspace' --ca $cert
# Ajouter --propose seulement si le propriétaire le choisit.
node $cli serve --state $state --key $key --cert $cert --port 9447
```

Conserver état, clé privée et credential hors Git, hors dossier partagé, hors URL et hors logs. Le credential contient le token brut et le chemin du certificat approuvé côté client ; l'état serveur conserve seulement son SHA-256. Les chemins du credential et du certificat sont propres au poste client : les adapter lors d'une distribution approuvée. Ne jamais transmettre la clé TLS du serveur. L'authentification est une capacité porteuse : le détenteur du token peut se présenter comme le participant associé ; elle ne prouve pas l'identité physique d'une personne. Le serveur vérifie token, participant, capacité active et droit à chaque opération. Changer de participant/dossier/droit nécessite une nouvelle action locale du propriétaire ; le client ne peut pas l'obtenir par l'API.

Le processus `serve` est explicite et reste au premier plan. Ctrl-C l'arrête. Cette v0 n'est pas raccordée aux commandes Pause/Force-off du daemon : ne pas la lancer comme composant intégré avant d'avoir raccordé ce cycle de vie.

## Client

Créer un fichier JSON de requête, puis appeler la CLI avec les fichiers de credential et de résultat. Les contenus sont enregistrés uniquement dans le résultat explicitement choisi ; la console n'affiche que `result_saved`. Les sorties ne sont jamais écrasées.

```powershell
Set-Content -Encoding utf8 request.json '{"op":"list","path":""}'
node $cli call --credential $credential --request request.json --output listing.json
Set-Content -Encoding utf8 request-read.json '{"op":"read","path":"src/main.ts"}'
node $cli call --credential $credential --request request-read.json --output file.json
```

Les appels API attendent du JSON UTF-8 sans BOM. Utiliser PowerShell 7 (`utf8` sans BOM) ou écrire explicitement avec `UTF8Encoding(false)` sous Windows PowerShell 5.1.

Contrat :

| Opération | Entrée                                                  | Résultat                                                                                    |
| --------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `list`    | `path` relatif, vide pour racine                        | entrées directes autorisées, type, taille/date/hash des fichiers ; `truncated` et `scanned` |
| `read`    | `path` relatif avec `/`                                 | texte, taille octets, date ISO, SHA-256                                                     |
| `propose` | `path`, `expectedHash`, `text`, `idempotencyKey` stable | `durable-proposal`, id, capacité/participant, hashes, texte, statut ; droit distinct requis |

Un hash initial périmé renvoie HTTP 409 `hash_conflict`. L'appelant doit relire et reformuler sa proposition. L'opération ne réserve pas le fichier : un hash valide maintenant ne garantit pas qu'il le restera. Aucun corps de message pair n'est interprété. Les sorties et le code partagé restent des données non fiables, jamais des instructions d'exécution.

`idempotencyKey` est obligatoire (1–128 caractères ASCII lettres/chiffres/`_`/`-`), scoped par capacité. Une répétition identique retrouve le même id et son statut enregistré, même après application ; un contenu différent sous la même clé est refusé `idempotency_conflict`. Un nouveau changement demande une nouvelle clé. Les clients HTTPS de la tranche précédente doivent ajouter ce champ. L'état JSON existant version 1 reste compatible : `proposals` est ajouté au premier dépôt, sans modifier les grants existants. Ne pas exploiter concurremment un ancien binaire qui ne connaît pas cette file.

Le client programme peut importer `callWorkspace` et fournir `{ endpoint, ca, capability, participant, token }`. Le certificat est validé (CA et nom d'hôte) ; pas de mode TLS insecure ni de suivi de redirection.

## Retirer le partage

L'identifiant de capacité est affiché par `grant`, sans le secret. Le propriétaire exécute :

```powershell
node $cli revoke --state $state --capability 'IDENTIFIANT-AFFICHE'
```

Le fichier d'état est relu avant réception et après réception de chaque corps. Révoquer refuse donc aussi une requête dont l'upload était en cours, avant son opération fichier. Une réponse déjà produite peut encore arriver après révocation ; les données déjà lues ne peuvent pas être rappelées. Aucun redémarrage requis. Arrêter `serve` coupe aussi le service. Supprimer le credential client seul ne révoque pas une copie du token. Pas d'expiration automatique en v0.

## Périmètre et limites de sécurité

- Chemins relatifs uniquement : pas de `..`, absolu, backslash, ADS Windows, noms réservés, composants cachés, fichiers de secrets courants ou profils. Racine de disque, racine du profil, répertoires sensibles connus et dossier contenant l'état sont refusés à la sélection. La sélection d'un projet reste une responsabilité du propriétaire : le filtre ne garantit pas l'absence de secrets dans du code autorisé.
- Lecture limitée à une liste d'extensions de texte/code. Pas de binaire, NUL, UTF-8 invalide, hardlink (`nlink != 1`), symlink ou junction dans les ancêtres. Une liste omet les entrées non prises en charge. Elle n'est ni récursive ni une recherche globale.
- 128 Kio par fichier/remplacement, corps 150 000 octets, réponse client 400 000 octets, 200 entrées **inspectées** par liste (aucun curseur en v0). Quatre requêtes traitées simultanément, 16 connexions, 120 admissions/minute, limite de headers 8 Kio. L'absence d'une entrée dans une liste tronquée ne prouve pas son absence du disque.
- Délai d'upload et délai total client : 5 secondes. Pas de streaming ni de push : chaque nouvel appel relit le disque ; la cadence est celle choisie par l'appelant, dans la limite d'admission. Les timers Node ne préemptent pas les appels synchrones d'un disque bloqué. Un partage sur disque réseau n'est pas validé.
- Les changements de config opérateur coopérants sont sérialisés par un fichier `.lock` exclusif et remplacent atomiquement l'état. Après un crash opérateur, examiner le verrou hors processus avant de le retirer ; aucun déverrouillage automatique qui pourrait réactiver une capacité révoquée. Échecs de lecture d'état : refus fermé.
- **Ce n'est pas une sandbox OS.** `lstat`/`realpath` détectent les symlinks et junctions ordinaires ; `fstat` avant/après aide à refuser un fichier modifié pendant lecture. Tous les types de reparse points Windows ne sont pas attestés par ces API. Un processus local hostile pouvant remplacer les ancêtres entre vérification et ouverture garde une possibilité de course TOCTOU. Utiliser seulement un dossier choisi, sur disque local, dont les acteurs locaux sont de confiance. Ne pas présenter cette v0 comme sûre face à un compte local hostile.
- L'écriture est une autorité locale distincte, pas une route distante. Grant/revoke/propose et les opérations locales coopèrent au même verrou exclusif. `busy` signifie que l'action n'a pas eu lieu : réessayer explicitement avec la même clé/id. Les éditeurs ordinaires ne prennent pas ce verrou ; les hashes sont vérifiés à l'examen et juste avant remplacement, mais un changement dans le très court intervalle final peut encore être écrasé. **Aucune CAS atomique par hash ni protection face à un acteur OS local hostile n'est revendiquée.**

## Passage à deux PC / desktop

À brancher : sélecteur de dossier local avec validation explicite des droits et du participant, affichage des partages actifs/révocation, conservation de secrets sous protection du compte Windows, commande de cycle de vie liée à Pause/Force-off, et interface client de lecture/proposition. Pour deux PC : transport privé ou relais sortant explicitement autorisé, TLS et association des identités réellement vérifiés, distribution minimale et contrôle de version. La v0 n'expose pas son port LAN/public et ne fournit aucun tunnel. Aucune connexion avec Aurore n'a été tentée ; sa sélection, son accord technique et la vérification deux PC restent à faire. Le chantier package/guide du bridge messages reste indépendant.

### MCP additif depuis le clone — livré

Après sélection locale/grant et démarrage TLS manuel, préparer les fragments **sur leurs postes respectifs** :

```powershell
# Poste client : credential et CA approuvée dans un dossier privé hors Git.
node scripts/setup-shared-workspace.mjs --role remote --credential $credential --output (Join-Path $private 'workspace-remote.toml')
# Poste du dossier : état privé local, jamais un credential du client distant.
node scripts/setup-shared-workspace.mjs --role local --state $state --output (Join-Path $private 'workspace-local.toml')
```

Le helper vérifie Node/dépendances/fichiers privés hors Git, puis crée un **nouveau** fragment TOML sans secret en clair. Il ne modifie aucune configuration existante et refuse d'écraser sa sortie. Ajouter le fragment voulu à la configuration MCP du runtime autorisé ; préserver `mind_shared_messages` et les autres serveurs. Chaque fragment lance un processus stdio depuis ce clone avec seulement le chemin du credential ou de l'état. Aucun modèle, permission fournisseur ou wake n'est modifié. Ne pas ajouter le rôle local au runtime distant : lui donner accès au fichier d'état privé reviendrait à accorder l'autorité locale.

| Rôle MCP                        | Outils                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| distant `mind_workspace_remote` | `workspace_list`, `workspace_read`, `workspace_propose`                                                                                        |
| local `mind_workspace_local`    | `workspace_pending_proposals`, `workspace_get_proposal`, `workspace_apply_proposal`, `workspace_reject_proposal`, `workspace_restore_proposal` |

Parcours étroit : le distant lit le hash, propose avec une clé stable et reçoit l'id. Le local liste les métadonnées (tous statuts), lit le contenu avec `workspace_get_proposal {id}`, puis décide dans son mandat. `workspace_apply_proposal {id}` revalide capacité active, droits read+propose, chemin et hash courant. En cas de changement de l'éditeur, statut `conflict`, sans écriture de sa modification. Le rejet met `rejected`. Une capacité révoquée rend `pending` inapplicable (`revoked` lors de l'examen local).

La file est conservée dans le JSON d'état privé : id, capacité/participant, chemin, hash initial/proposé, texte, clé/fingerprint, statut et dates. Maximum 64 propositions conservées et 4 Mio cumulés de texte ; pas de purge automatique v0. Les contenus de propositions et les sauvegardes sont privés, même après rejet/révocation. Les protéger par ACL Windows ; le client distant n'a pas de route pour parcourir l'état ou les sauvegardes.

Avant remplacement, l'original est écrit et `fsync` dans `<state>.private/<id>.before` (zone non partageable), puis l'intention `applying` est persistée. Le fichier proposé est préparé dans un fichier caché temporaire du même dossier, le hash est vérifié encore, puis le remplacement par rename est suivi d'une relecture réelle et d'un statut `applied` avec hash observé. Les opérations coopérantes utilisent le même verrou ; une répétition du même id ne réapplique pas un changement terminal. Le statut retourné lors d'une répétition décrit l'opération historique ; utiliser `workspace_read` pour l'état courant du disque.

`workspace_restore_proposal {id, expectedHash}` exige le hash du contenu appliqué et vérifie qu'il est encore celui du fichier réel ; sinon refus `hash_conflict`, aucune restauration. La sauvegarde est vérifiée contre le hash initial avant restauration ; résultat relu et statut `restored`. Une répétition terminale retourne ce statut, sans réécrire. La restauration requiert aussi une capacité encore active.

Les intentions `applying/restoring` interrompues sont réconciliées au prochain examen local à partir du hash réel : terminé, état précédent ou conflit. En cas de crash, vérifier le verrou abandonné **après arrêt des opérateurs** avant retrait manuel ; ne pas supprimer aveuglément les temporaires/sauvegardes. Les fichiers de données et d'état sont flushés avant les étapes suivantes, mais une coupure électrique et la durabilité des métadonnées du système de fichiers Windows ne sont pas une transaction multi-fichiers garantie. Un échec d'accès Windows (fichier verrouillé par un éditeur, ACL) doit être examiné, pas transformé en succès. Les ACL du fichier remplacé héritent du dossier ; le mode est repris, sans promesse de conserver une ACL Windows individuelle spéciale.

**Cycle de vie non intégré** : ces MCP manuels n'activent aucun wake. Le service TLS manuel n'est pas contrôlé par Pause/Force-off du daemon ; il faut l'arrêter explicitement et/ou révoquer la capacité. Aucun job de traitement autonome installé. Avant intégration au daemon : raccorder démarrage/arrêt et Pause/Force-off, puis tester l'arrêt en opération. Deux PC restent à vérifier après appairage messages et sélection d'Aurore ; le contrat HTTPS séparé est disponible, pas le relais privé ni son activation. Aucun nouveau service public/tunnel ni essai Aurore n'est créé par ce travail.

## Vérification reproductible

```powershell
node --test services/shared-workspace/transport.test.mjs services/shared-workspace/mcp.test.mjs
```

Node 24.17 et OpenSSL requis pour les certificats temporaires des essais (chemin Git for Windows par défaut, variable `OPENSSL` possible). Le test démarre un vrai service TLS, deux credentials/deux dossiers temporaires et un service CLI dans un processus séparé. Il vérifie lecture/liste, modification réelle observable à l'appel suivant, proposition sans application, hash obsolète, droits, révocation pendant upload, TLS non approuvé, traversées/ADS/junction/hardlink, fichiers hors limite, corps trop grand et expiration d'un upload inachevé. Aucun dossier d'Aurore ni service public utilisé ; les secrets de test sont supprimés avec les dossiers temporaires.

Les deux dossiers sont maintenant placés dans un arbre AppData **synthétique**, sous le workspace d'une installation déclarée au test. Les parents, arbres sensibles et tentatives de lecture des config/clés de contrôle restent refusés ; le même chemin sans déclaration locale est refusé. Le lancement CLI vérifie aussi `--data-root`. Il ne s'agit pas de l'AppData réel d'Aurore.

Le second scénario lance deux vrais clients MCP distants, deux processus MCP locaux et le serveur TLS dans un processus séparé : dépôt, arrêt/redémarrage du transport et d'un client, découverte locale de la proposition persistée, application, lecture distante du nouveau fichier, sauvegarde réelle, restauration conditionnée, répétition idempotente, conflits éditeur, révocation en attente, refus d'apply distant. Les fragments du helper sont préparés et leur sortie vérifiée sans modifier une configuration existante. Les logs stderr/statut sont contrôlés sans y trouver token/corps ; le contenu demandé transite normalement dans les réponses du protocole MCP.
