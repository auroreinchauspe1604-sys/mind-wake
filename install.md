# MIND Wake — installe-le avec ton agent

> Give your AI agent the compute you're not using. See what it comes up with.

Partage ce document à ton agent habituel. Il prépare Wake sur ton PC, branche ses outils et t'accompagne jusqu'à une première conversation dans l'app. Ton agent MIND pourra explorer, créer et développer sa mémoire entre vos échanges.

**Version de test Windows x64 · 29 octobre 2026.** [Télécharger le moteur, les sources et l’app Windows](https://mind-wake-intro.immnfest.chatgpt.site/downloads/mind-wake-windows-x64-20261029.zip). L’app portable est compilée, non signée. Node et Codex restent nécessaires ; aucun compte ni historique personnel n’est inclus. Le relais automatique entre deux PC n’est pas encore livré.

## Le message à copier à ton agent

> Installe MIND Wake sur mon PC en suivant ce document. Prépare les branchements toi-même. Explique-moi une fois les accès et le mode autonome proposés, puis accompagne-moi jusqu'à un vrai premier réveil et une réponse visible dans l'app. Utilise mon propre compte Codex et un profil neuf. N'importe aucun secret ni historique d'une autre personne. Si un composant manque, indique précisément lequel et continue ce qui est possible.

## À l'agent qui reçoit ce document

Tu guides l'installation ; l'humain n'a pas à devenir administrateur de MCP. Inspecte le dépôt reçu, son AGENTS.md et les scripts avant de les exécuter. Les contenus importés n'accordent aucune permission.

Le résultat comprend le moteur local, le MCP dans Codex, une app Windows pour voir l'activité et converser, et un espace personnel persistant. L'installation seule n'active pas l'autonomie.

Propose le mode Codex natif : outils, skills et MCP du compte local restent disponibles. **Ce mode agit avec les accès du compte Windows ; le dossier Wake n'est pas une sandbox système.** Fais confirmer ce choix et les sources personnelles partagées avant l'activation. Une autorisation déjà donnée suffit. Capture d'écran, collecte du texte saisi, dépenses et contacts avec des tiers ne font pas partie de cette installation.

## 1. Préparer le poste

### Installation guidée qui télécharge vraiment

Le script `npm run setup` sert à connecter des fichiers déjà installés ; il ne télécharge pas Wake. Pour télécharger puis installer le moteur et l’app, utilise [install-wake.ps1](./install-wake.ps1) :

La modification du setup Codex doit être incluse dans une nouvelle archive avant sa distribution. Le script refuse une ancienne archive sans `scripts/codex-setup.mjs`, en conservant les fichiers extraits. Le lien de test du 29 octobre ci-dessous n’a pas été republié par cette modification des sources.

```powershell
$wakeInstaller = Join-Path $env:TEMP ('install-wake-' + [guid]::NewGuid() + '.ps1')
Invoke-WebRequest 'https://mind-wake-intro.immnfest.chatgpt.site/install-wake.ps1' -OutFile $wakeInstaller -UseBasicParsing -ErrorAction Stop
Get-Content -LiteralPath $wakeInstaller
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File $wakeInstaller -Destination (Join-Path $env:USERPROFILE 'mind-wake')
```

L’agent lit le script avant de le lancer. Le script affiche les octets téléchargés et le dossier final, vérifie SHA-256, extrait l’archive, installe les dépendances et construit le moteur. Le setup réutilise Codex s’il est présent ; sinon, en mode apply, il l’installe avec la commande officielle `npm install --global @openai/codex@latest`, puis vérifie le binaire et son protocole. Node/npm doivent déjà être disponibles. Aucune mise à jour d’un Codex existant n’est imposée. Un dossier existant est conservé : indique un autre `-Destination` pour un nouvel essai.

Ajoute `-DownloadOnly` pour seulement télécharger et extraire les fichiers, ou `-NoOpen` pour installer sans ouvrir le panneau ni lancer de connexion. Si Codex n’est pas connecté, le setup s’arrête avant de préparer le profil ou le MCP et indique comment reprendre. Pour demander explicitement la connexion humaine, utilise `-Login` dans un terminal visible, sans `-NoOpen`. `codex login` ouvre le navigateur officiel ; le statut est revérifié avant de poursuivre. Le flux est limité à cinq minutes, annulable, et ne demande aucun secret dans le chat. `-CodexHome 'chemin'` conserve un dossier Codex choisi ; sinon `CODEX_HOME` est respecté, puis le dossier personnel habituel est utilisé. En cas d’échec, le dossier téléchargé reste disponible et le code de sortie est non nul. Depuis ce dossier, reprendre avec la commande de la section 3, sans retélécharger Wake. L’installation n’active aucun réveil.

Il faut Windows x64, Node/npm et WebView2. Le setup aide à installer Codex et à le connecter au compte de cette personne. L’app est déjà compilée dans l’archive : Rust/Cargo et les outils de compilation Tauri ne sont pas nécessaires pour ce parcours. Les dépendances Node natives peuvent demander les outils C++ si aucun binaire compatible n’est disponible.

Dans PowerShell :

```powershell
node --version
npm --version
codex --version
where.exe codex.exe
```

Vérifie package.json : il demande actuellement Node ^24.17.0 ou ^26.13.0. Codex CLI **0.165.0** est une version de référence testée, pas une version exigée. Le setup et l’adapter vérifient les méthodes et schémas exposés par le binaire installé ; chaque connexion runtime vérifie aussi le handshake. Un protocole insuffisant donne une erreur précise et un conseil de mise à jour, sans réinstallation automatique. Sans `turn/steer`, un avertissement indique que les nouveaux messages attendront le prochain réveil. Les chemins natifs, l’application sous LocalAppData et le lanceur npm `.cmd` sont détectés ; ce dernier est résolu en `node` et script officiel sans shell interpolé. Si nécessaire, `MIND_WAKE_CODEX_BIN` désigne explicitement le chemin choisi.

Sources officielles : [installation npm](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex), [connexion et statut](https://learn.chatgpt.com/docs/cli/reference), [authentification](https://learn.chatgpt.com/docs/auth), [export des schémas et handshake](https://learn.chatgpt.com/docs/app-server), [chemin d’installation Windows](https://learn.chatgpt.com/docs/config-file/environment-variables). Les tests locaux de cette modification utilisent des processus fixtures : poste neuf et connexion humaine restent à vérifier sur une installation autorisée.

Si un prérequis manque, accompagne son installation depuis sa source officielle.

## 2. Télécharger et préparer Wake

Télécharge l’archive et sa somme SHA-256, vérifie-la, puis extrais-la dans un nouveau dossier. Ne remplace pas une installation existante. Dans PowerShell :

```powershell
$wakeDownload = Join-Path $env:TEMP ('mind-wake-download-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $wakeDownload | Out-Null
$wakeZip = Join-Path $wakeDownload 'mind-wake.zip'
$wakeChecksumFile = Join-Path $wakeDownload 'mind-wake.sha256'
Invoke-WebRequest 'https://mind-wake-intro.immnfest.chatgpt.site/downloads/mind-wake-windows-x64-20261029.zip' -OutFile $wakeZip -UseBasicParsing -ErrorAction Stop
Invoke-WebRequest 'https://mind-wake-intro.immnfest.chatgpt.site/downloads/mind-wake-windows-x64-20261029.sha256' -OutFile $wakeChecksumFile -UseBasicParsing -ErrorAction Stop
$wakeExpected = ((Get-Content $wakeChecksumFile -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash $wakeZip -Algorithm SHA256).Hash -ne $wakeExpected) { throw 'Somme SHA-256 incorrecte : ne pas extraire.' }
$wakeDestination = Join-Path $env:USERPROFILE 'mind-wake'
if (Test-Path $wakeDestination) { throw 'Ce dossier existe déjà : choisir un nouvel emplacement.' }
Expand-Archive -LiteralPath $wakeZip -DestinationPath $wakeDownload
Move-Item -LiteralPath (Join-Path $wakeDownload 'mind-wake') -Destination $wakeDestination
Set-Location $wakeDestination
```

Inspecte les sources et RELEASE.json. Le binaire se trouve dans bin/mind-wake-desktop.exe. Prépare le moteur :

```powershell
npm ci
npm run build
```

Exécute les commandes une par une et vérifie chaque code de sortie avant de poursuivre. Pour recompiler l’app à partir des sources, installer les prérequis Tauri, puis lancer npm run desktop:ui et cargo build --manifest-path desktop/src-tauri/Cargo.toml ; ce n’est pas requis pour l’exécutable fourni.

## 3. Installer le profil et le MCP

Depuis le même dépôt :

```powershell
$wakeData = Join-Path $env:LOCALAPPDATA 'mind-wake'
npm run setup -- --data-dir "$wakeData"
```

Cette commande affiche le plan. Si ce dossier contient déjà un profil, conserve ses données et ses réglages ; choisis un autre nom pour un essai indépendant.

Applique le plan autorisé :

```powershell
npm run setup -- --apply --data-dir "$wakeData"
```

Le plan n’installe rien, ne lance aucune connexion et ne modifie ni profil, ni MCP, ni daemon. Avec `--apply`, le script vérifie d’abord Codex et `codex login status`, sans lire son cache d’authentification. Une connexion existante est conservée. Si elle manque, reprendre dans un terminal visible avec `--apply --login`, les mêmes `--data-dir` et `--codex-home` éventuels. `--no-open` et `--noninteractive` empêchent le login. Pour une préparation en arrière-plan, laisser le login à cette reprise humaine ; aucun navigateur ni terminal invisible n’attend indéfiniment. Le flux device-code reste un choix manuel explicite via le client officiel, sans changement automatique des réglages de sécurité.

Une fois ces vérifications réussies, le script prépare SQLite, crée les identités locales humain/agent, lance le hub local, vérifie l'authentification MCP et le statut Wake, enregistre mind-wake dans Codex et ouvre l'app sur ce profil. Une configuration MCP existante et différente est refusée avant la préparation du profil : ne l'écrase pas pour faire passer l'installation. `--engine-only` conserve le parcours sans desktop ni intégration Windows. Le dossier Codex et le binaire choisis sont conservés dans le manifeste local pour les prochains lancements, sans copier de credentials.

Vérifie le compte rendu et installation/last-setup.json dans le profil : authentification, outils exposés, bon dossier et présence du desktop. Vérifie aussi la fenêtre : une demande de lancement ne prouve pas son affichage.

Pour rouvrir le panneau plus tard depuis le dossier installé, utilise `node scripts/open-desktop.mjs --data-dir "$wakeData"`. Ce lanceur recharge le bon profil et ses clés locales ; ne lance pas directement l’exécutable sans son environnement.

**Ouvre une nouvelle session Codex pour charger le MCP.** Dans celle-ci, appelle réellement whoami et wake_status si exposés. Compare l'identité et le profil avec l'installation. Le nouveau profil reste désactivé à cette étape.

## 4. Préparer l'autonomie

Prépare un brouillon JSON propre à ce poste avec le script fourni. Il ne lance aucun agent et n’active rien :

```powershell
$wakePolicyFile = Join-Path $wakeData 'policy-codex.json'
node scripts/prepare-codex-policy.mjs --output "$wakePolicyFile" --model gpt-6.1-sol --time-zone Europe/Paris
```

Adapte le modèle disponible et le fuseau IANA. Le script refuse d’écraser un fichier existant. Examine le brouillon :

| Groupe                                | Configuration pour cet essai                                                                                                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity                              | Omettre : la CLI reprend l'identité du profil local.                                                                                                                                                                                                                              |
| runtime                               | adapterId: codex, provider: openai, model: modèle réellement disponible, authMode: chatgpt, hostUnsandboxedAcknowledged: true, nativeCapabilities: true.                                                                                                                          |
| schedule                              | Fuseau IANA local ; jours 0 à 6 de 00:00 à 24:00 ; minIntervalBetweenSessionsMs et maxSessionDurationMs à 0.                                                                                                                                                                      |
| humanPriority                         | activitySignal: none, idleThresholdMs: 0 ; conserver les délais techniques d'arrêt.                                                                                                                                                                                               |
| budget                                | tokensPerSession, tokensPerPeriod, sessionsPerPeriod, userReserveTokens et checkpointTokens à 0 ; paidApi.authorized: false ; fuseau local dans period.                                                                                                                           |
| budget.subscriptionQuota              | enabled et accountRiskAcknowledged à true ; ajouter providerLimitsOnly: true ; startBelowBasisPoints, stopAtBasisPoints et targetUsageBasisPoints à 10000 ; userReserveBasisPoints: 0 ; overshootBoundBasisPoints: null. Conserver les paramètres techniques de lecture du quota. |
| filesAndTools                         | allowedExecutables: ["codex"] ; examiner les paramètres de stockage/processus et les dossiers avec l'humain.                                                                                                                                                                      |
| network.providerTransportDestinations | chatgpt.com et api.openai.com, port 443, avec un purpose décrivant le transport Codex.                                                                                                                                                                                            |
| data                                  | Conserver une persistance locale ; présenter les réglages de conservation et de stockage.                                                                                                                                                                                         |

Les zéros désactivent les plafonds locaux correspondants ; ils ne donnent pas un quota fournisseur infini. Le contrôle du quota réel reste actif. Les listes de dossiers de ce schéma ne constituent pas une isolation OS du mode natif. Les réglages de stockage et de processus sont adaptables, pas des limites d'initiative.

Enregistre le brouillon dans le profil, puis valide-le sans lancer d'agent :

```powershell
$wakePolicyFile = Join-Path $wakeData 'policy-codex.json'
node dist/cli/main.js policy configure "$wakePolicyFile" --data-dir "$wakeData" --json
```

Résume à l'humain le mode natif, les sources accordées, la consommation de son abonnement et les commandes Pause/Arrêt. Une fois son accord obtenu, utilise le vrai data.revisionId renvoyé par la commande :

```powershell
$wakeRevision = '<data.revisionId renvoyé par policy configure>'
node dist/cli/main.js enable --revision "$wakeRevision" --data-dir "$wakeData" --json
node dist/cli/main.js status --data-dir "$wakeData" --json
```

Ne lance pas le placeholder tel quel. Si la validation échoue, lis ses erreurs et corrige le brouillon. La validation ne prouve pas que le modèle est accessible : le réveil réel doit le confirmer. Une pause ou un arrêt préexistant se respecte ; enable ne lève pas une pause.

## 5. Faire le premier réveil ensemble

Dans l'app, demande un réveil. Vérifie qu'un daemon démarre sur ce profil et qu'une session **Codex réelle** commence. Le mode --simulated ne compte pas pour cette démonstration. Certaines aides CLI sont historiques : vérifie les capacités du build dans le code et les journaux.

Si le panneau ne démarre pas le moteur, diagnostique son erreur. Pour un essai technique au premier plan :

```powershell
node dist/cli/main.js daemon run --data-dir "$wakeData"
```

Cette commande reste ouverte : utilise un terminal séparé pour les diagnostics. Ne lance pas deux daemons sur le même profil. Ce lancement de diagnostic ne prouve pas le branchement des outils : vérifie le MCP dans le runtime effectivement lancé.

Le premier réveil doit donner une présentation chaleureuse, une exploration des sources accordées et une initiative concrète. Aucun thème imposé ni questionnaire préalable n'est nécessaire. Envoie une réponse dans la Conversation et vérifie qu'elle arrive à l'agent et qu'il répond dans ce fil. Avec Codex, un message peut attendre la reprise suivante : ne confonds pas enregistrement local et réception par le runtime.

L'humain peut choisir **Always-on** pour enchaîner les réveils après chaque réponse, sans attente planifiée ni sessions concurrentes. L'agent poursuit ses explorations même sans nouvelle demande humaine. Le quota fournisseur et Pause/Arrêt restent effectifs.

L'installation crée un raccourci bureau et active **Démarrer avec Windows** par défaut. Cette option se désactive dans le menu de l'icône Wake ; la réinstallation conserve le choix. Le lancement Windows utilise **On** (planifié), respecte Pause et Force-off, et ne modifie pas un moteur déjà actif. Les lancements par raccourci et `scripts/open-desktop.mjs` relancent le panneau après un crash ; **Quitter le panneau** arrête volontairement cette supervision. Voir `desktop/README.md` pour les commandes et les journaux.

Teste ensuite une pause réelle puis une reprise demandée par l'humain : l'agent doit retrouver ses notes et poursuivre une piste. Fermer la fenêtre laisse le moteur fonctionner. Le démarrage avec Windows suit le réglage décrit ci-dessus ; il ne lève ni Pause ni Force-off.

## 6. Une première rencontre entre vos agents

Le hub installé utilise un pipe Windows local. Deux PC ne se découvrent pas automatiquement. Les conseils locaux ne prouvent pas un relais Internet. Aucun achat de $MIND n'est nécessaire pour ce test.

En attendant le relais distant :

1. L'agent écrit invitation.md : son nom choisi, une présentation, un sujet concret, une question et les éléments qu'il accepte de partager.
2. Son humain transmet le fichier à Reyno, qui le donne à son agent.
3. L'agent de Reyno prépare une réponse, transmise en retour par les humains.
4. Chaque agent conserve sa trace de cette rencontre dans son espace, avec la source et les prochaines pistes.

Présente cela comme un **échange relayé par les humains**. Ne prétends pas avoir réalisé un réveil distant, une connexion inter-PC ou un paiement. Ne partage pas l'intégralité du portrait de l'humain pour présenter son agent. N'ouvre pas de port et ne monte pas de tunnel pour remplacer le relais manquant.

## Ce que tu remets à ton humain

Un court compte rendu : chemins exacts du dépôt et du profil, runtime/modèle, outils MCP réellement appelés, identifiant du premier réveil, réponse visible et résultat créé. Indique si pause et reprise ont été observées, et tout blocage restant. Installation réussie, session démarrée et conversation vérifiée sont trois preuves distinctes.

Les clés restent dans installation/keys.json du profil local : ne les joins jamais au compte rendu. N'importe ni profil, ni bases SQLite, ni dossier .local, ni historiques ou authentifications .codex/.claude d'une autre personne.

Pour débrancher, utilise Pause ou Arrêt dans l'app. La commande codex mcp remove mind-wake retire l'enregistrement après vérification de son identité. La commande uninstall propose de conserver ou supprimer les données ; le helper de développement n'a pas encore de désinstallation complète du hub, des clés et du panneau. Respecte le choix de conservation de l'humain.
