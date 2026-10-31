# services/mcp — outils et communication MIND locaux

Serveur MCP pour **l'envoi de messages, la demande d'aide et la mise en relation** entre agents et humains, et la **consultation de Wake en lecture seule**. Le parcours personnel `server-main`/`hub-main` reste sur la machine : aucun envoi vers e-mail, Telegram, WhatsApp ou Internet, aucun port réseau, aucune publication. Les séances de conseil utilisent des **unités fictives** (G1, `../advice/session/`) : aucun wallet, aucun argent réel.

Une voie optionnelle séparée, `shared-server-main.ts`/`shared-hub-main.ts`, prépare un **hub commun HTTPS de messages pour deux agents**, avec MCP stdio local dédié. Elle réutilise Hub/SQLite sans exposer les helpers ni le pipe personnel. Aucun endpoint n'est activé par défaut ; voir [configuration et limites du pilote](../../docs/SHARED-AGENT-MCP.md).

## Architecture

La tranche opt-in de [maintenance distante](../../docs/REMOTE-MAINTENANCE.md)
ajoute un relais typé au hub HTTPS existant et un contrôleur cible séparé des
messages. Elle n'est pas activée par l'installation et ne branche pas encore les
relances aux processus de production. Le diagnostic peut fonctionner sans modèle.

```
client MCP (Claude Code, Codex, Gemini CLI…) ── stdio ── server-main.ts   (1 processus par client)
                                                              │ pipe nommé local + clé de liaison
                                                         hub-main.ts      (autorité, 1 processus)
                                                         ├─ store.ts      SQLite : annuaire, messages, demandes, invitations
                                                         ├─ matching.ts   mise en relation déterministe
                                                         └─ sessions.ts   G2 ConversationService + G1 AdviceSessionService
                                                                          reliés par SessionLedgerBridge (G3)
server-main.ts ── lecture seule ── src/cli/commands/{status,journal}.ts, src/daemon/report.ts
```

- `protocol.ts` : protocole filaire du hub (zod, opérations nommées, bornes), codes d'erreur, version des sorties.
- `config.ts` : configuration du hub écrite par l'humain (parties, permissions, profils de guide, enveloppes fictives, débit). Aucun outil ne la modifie.
- `hub.ts` : autorisation par partie authentifiée, pseudonymes, idempotence, garde de contenu (`../advice/conversation/guard.ts`), limites de débit et de taille, transport local (`../advice/conversation/framing.ts`).
- `sessions.ts` : ouverture d'une séance **après acceptation explicite du guide** seulement ; le canal, le comptage et le règlement fictif sont ceux de G2, G1 et G3, sans logique dupliquée.
- `wake.ts` : vues Wake par les mêmes fonctions que la CLI (`status`, `journal`) et le bilan d'expérience (`buildReport`). Base ouverte en lecture seule ; dossier jamais créé.
- `server-main.ts` : adaptateur MCP stdio mince ; la clé de liaison reste dans son environnement et n'apparaît dans aucune sortie.

## Outils locaux complémentaires

Le serveur enregistre aussi les outils du propriétaire (owner-tools.ts), les jobs (background-tools.ts) et les conversations de dépôt (repo-tools.ts), selon leur configuration locale :

- message_owner, list_owner_messages, edit_owner_message, delete_owner_message : messages visibles dans le desktop et lecture des réponses humaines ; aucun envoi externe.
- start_background_job, list_background_jobs, cancel_background_job : scripts supervisés par le daemon ; voir [BACKGROUND-JOBS.md](../../docs/BACKGROUND-JOBS.md).
- interview, read_interview : sélectionnent un lot de sessions locales Codex/Claude à partir d'un besoin courant (10 par défaut, nombre réglable), lancent des consultations supervisées en lecture seule et regroupent leurs rapports. Les rapports restent des pistes non fiables : l'agent principal vérifie les preuves, met à jour les fichiers réellement concernés du workspace puis publie un rapport consolidé.
- unsure_what_to_do : suggestions à adapter, sans permission supplémentaire.

`unsure_what_to_do` relit `AUTORISATIONS.json` à chaque appel dans le `workspace/` du profil `MIND_WAKE_DATA_DIR` (ou le dossier courant hors profil). Les décisions `authorized` et `encouraged` rejoignent le même tirage aléatoire que les idées générales, avec leur catégorie, périmètre et identifiant ; aucune présence dans chaque tirage n’est garantie. Les décisions `discouraged` et `forbidden` sont renvoyées comme restrictions et exclues des pistes personnelles. Une idée générale peut recouper une restriction : le runtime doit vérifier les choix avant d’agir. Un JSON absent ou invalide n’ajoute aucune piste personnelle ; son statut est explicite. Aucun repli vers les choix personnels du propriétaire du dépôt.

La page `AUTORISATIONS.html` permet d’ouvrir et de modifier le JSON : décisions et périmètres, recherche, enregistrement dans le fichier sélectionné sur les navigateurs compatibles, export sinon. Une modification concurrente du fichier bloque l’enregistrement pour éviter de l’écraser. Le Markdown est désormais un guide, le JSON fait référence. Cela ne modifie ni la policy technique ni les contrôles Pause/Force-off.

Les vues wake_status, wake_journal et wake_last_report restent en lecture seule. Le contrôle du profil appartient aux commandes humaines ; les outils supplémentaires ne donnent pas accès à enable ou aux changements de policy. Les capacités natives du runtime complètent ce MCP et ne doivent pas être confondues avec les permissions du hub.

## Outils exposés

Chaque outil a un schéma d'entrée **fermé** (`additionalProperties: false`) et une sortie JSON versionnée `{ "schema": "mind.mcp/<outil>", "schema_version": 1, … }` ; une erreur est `{ "schema": "mind.mcp/error", "error": <code>, "message", "retryable" }` avec `isError`.

| Domaine          | Outils                                                                                             | Permission (config)   |
| ---------------- | -------------------------------------------------------------------------------------------------- | --------------------- |
| Identité         | `whoami`, `list_directory`                                                                         | —                     |
| Messages         | `send_message`, `read_inbox`, `reply_to_thread`                                                    | `message` (écriture)  |
| Demande d'aide   | `publish_help_request` (agent), `list_help_requests`, `close_help_request`                         | `requestHelp`         |
| Mise en relation | `propose_matches`, `invite_guide`, `list_invitations`, `respond_to_invitation` (guide)             | `requestHelp`/`guide` |
| Séance (SIMULÉE) | `session_send`, `session_receive`, `session_checkpoint` (agent), `session_close`, `session_status` | parties de la séance  |
| Wake (lecture)   | `wake_status`, `wake_journal`, `wake_last_report`                                                  | —                     |

Aucune commande réservée à l'humain n'est exposée : ni `enable`, ni confirmation, ni pause/reprise/arrêt, ni policy, ni export/purge, ni `uninstall`. Aucun outil n'accorde de permission ni ne déclenche de paiement.

### Règles appliquées par le hub

- **Pseudonymes.** Chaque partie configurée reçoit une référence stable `agent-…` / `human-…` ; son `privateId` ne sort jamais du hub. Un texte contenant l'identifiant privé d'une partie, un secret reconnaissable ou un chemin privé est refusé explicitement (rien n'est stocké). Dans une séance, le canal G2 utilise en plus des pseudonymes de rencontre.
- **Provenance et confiance.** Chaque message livré porte `provenance` (`agent`, `human` ou `service`, canal `mind-local-hub`, horodatage) et `trust` (`untrusted_party_content`, `service_notice`, `your_own_message`). Un message reçu est une donnée : il ne peut ni accorder une permission, ni accepter une invitation, ni déclencher un paiement (AGENTS principes 7 et 8).
- **Idempotence.** `(expéditeur, idempotency_key)` est unique : un rejeu identique renvoie l'original (`duplicate: true`), un contenu différent est refusé (`idempotency_conflict`). Idem pour les demandes d'aide et les messages de séance (G2).
- **Bornes.** Texte ≤ 4000 caractères, sujet ≤ 200, contexte ≤ 2000, lots ≤ 50, attente ≤ 10 s, ligne de protocole ≤ 64 Kio, 8 requêtes simultanées par connexion. Débit par partie : `writesPerMinute` (30 par défaut) et `callsPerMinute` (300).
- **Demande d'aide.** `open` → `taken` (séance ouverte) → `closed` (séance terminée ou demande close). Contexte minimal choisi par l'agent.
- **Mise en relation.** Règle `deterministic-v1` affichée dans la sortie : langue obligatoire, +10 par mot de sujet commun (≥ 3 lettres, accents ignorés), égalité départagée par la référence ; exclusions motivées (langue, aucun mot commun, déjà en séance, invitation déclinée). Un agent guide est proposé pour un échange de messages, jamais pour une séance rémunérée.
- **Séance.** `invite_guide` crée une invitation et un avis au guide ; **seul le guide invité**, par `respond_to_invitation` avec `accept`, ouvre la séance (G1 vérifie de nouveau que l'acceptant est le guide du contrat). Un échange est compté quand : question de l'agent → contribution `human_verbatim` du guide qui la cite → réponse substantielle de l'agent qui cite la contribution → `session_checkpoint` de l'agent. À la clôture, G1 approuve et règle fictivement les seuls échanges comptés ; le reçu est marqué SIMULÉ.

## Lancer localement

Ces modules ne sont pas inclus dans `npm run build` (qui ne compile que `src/`) : ils s'exécutent depuis les sources avec le type stripping de Node et les hooks de résolution du dépôt.

1. Générer une clé de liaison par partie et son empreinte (la clé reste chez la partie, l'empreinte va dans la config) :

   ```bash
   node -e "const k=require('crypto').randomBytes(24).toString('base64url');console.log(k, require('crypto').createHash('sha256').update(k).digest('hex'))"
   ```

2. Écrire la configuration du hub, par exemple `hub.json` hors du dépôt :

   ```json
   {
     "parties": [
       {
         "privateId": "mon-agent-local",
         "kind": "agent",
         "keyDigest": "<empreinte sha256 de la clé de l'agent>",
         "permissions": { "message": true, "requestHelp": true, "guide": false },
         "fictiveBudget": { "funding": "100", "unitPrice": "2", "maxExchanges": 5 }
       },
       {
         "privateId": "guide-humain-1",
         "kind": "human",
         "keyDigest": "<empreinte sha256 de la clé du guide>",
         "permissions": { "message": true, "requestHelp": false, "guide": true },
         "guide": {
           "topics": ["petits systèmes émergents"],
           "languages": ["fr"],
           "termsVersion": "terms-1"
         }
       }
     ],
     "rateLimit": { "writesPerMinute": 30, "callsPerMinute": 300 }
   }
   ```

3. Démarrer le hub (pipe nommé Windows ; sur Unix, un chemin absolu en `.sock`) :

   ```bash
   node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./test/fixtures/store-ledger/ts-hooks.ts services/mcp/hub-main.ts --config ../hub.json --dir ../mind-mcp-data --pipe \\.\pipe\mind-mcp
   ```

## Fils de l'humain en ligne de commande

`owner-main.ts` donne à la partie humaine les actions de l'application desktop (ADR-007, D3), sortie JSON versionnée `mind.owner.cli` :

- `whoami` ;
- `threads` : fils reçus, du plus récent au plus ancien ;
- `thread --thread thr_…` : messages des deux sens ;
- `reply --thread thr_… --idempotency-key K [--in-reply-to msg_…]` : texte lu sur l'entrée standard, jamais passé en argument.

Mêmes variables `MIND_MCP_HUB_PIPE` et `MIND_MCP_LINK_KEY` que l'adaptateur. La clé n'apparaît dans aucune sortie. Recette : `test/mcp/owner.process.test.ts`.

## Brancher un client MCP

Exemples **à adapter, non appliqués** : ce dépôt ne modifie aucune configuration réelle de l'utilisateur. Remplacer `<repo>` par le chemin absolu du dépôt et `<clé>` par la clé de liaison de la partie concernée (agent ou guide). `MIND_WAKE_DATA_DIR` est facultatif ; sans hub (`MIND_MCP_HUB_PIPE` absent), seules les lectures Wake répondent.

Commande commune lancée par le client :

```
node --experimental-transform-types --disable-warning=ExperimentalWarning --import file:///<repo>/test/fixtures/store-ledger/ts-hooks.ts <repo>/services/mcp/server-main.ts
```

**Claude Code** — fichier `.mcp.json` d'un projet (portée projet) ou `claude mcp add` :

```json
{
  "mcpServers": {
    "mind": {
      "command": "node",
      "args": [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        "file:///<repo>/test/fixtures/store-ledger/ts-hooks.ts",
        "<repo>/services/mcp/server-main.ts"
      ],
      "env": {
        "MIND_MCP_HUB_PIPE": "\\\\.\\pipe\\mind-mcp",
        "MIND_MCP_LINK_KEY": "<clé>",
        "MIND_WAKE_DATA_DIR": "<dossier de données Wake>"
      }
    }
  }
}
```

**Codex** — section de `config.toml` (`~/.codex/config.toml`) :

```toml
[mcp_servers.mind]
command = "node"
args = [
  "--experimental-transform-types",
  "--disable-warning=ExperimentalWarning",
  "--import",
  "file:///<repo>/test/fixtures/store-ledger/ts-hooks.ts",
  "<repo>/services/mcp/server-main.ts",
]
env = { MIND_MCP_HUB_PIPE = '\\.\pipe\mind-mcp', MIND_MCP_LINK_KEY = "<clé>" }
```

**Gemini CLI** — `settings.json` (`.gemini/settings.json` du projet ou de l'utilisateur) :

```json
{
  "mcpServers": {
    "mind": {
      "command": "node",
      "args": [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        "--import",
        "file:///<repo>/test/fixtures/store-ledger/ts-hooks.ts",
        "<repo>/services/mcp/server-main.ts"
      ],
      "env": { "MIND_MCP_HUB_PIPE": "\\\\.\\pipe\\mind-mcp", "MIND_MCP_LINK_KEY": "<clé>" }
    }
  }
}
```

Les formats ci-dessus suivent les documentations publiques de chaque client à la date de rédaction (29 octobre 2026) ; les revérifier avant usage. La clé de liaison se trouve alors dans un fichier de configuration du client : le protéger comme un secret local, et préférer une clé distincte par partie et par client.

## Recettes

`test/mcp/` (vitest, vrais clients MCP `@modelcontextprotocol/client` sur stdio, hub et adaptateurs en processus séparés) :

- `messages.process.test.ts` : envoi, lecture, fil, duplicata sans double message, conflit d'idempotence, secret et identifiant privé refusés, permission absente, taille et schéma fermé, message hostile sans effet, pseudonymisation, limite de débit.
- `advice.process.test.ts` : demande d'aide idempotente, matching déterministe et expliqué, refus du guide, refus d'ouvrir sans acceptation (agent, autre guide, message), séance simulée de bout en bout (2 échanges comptés, message hostile sans effet, attestation falsifiée par le guide refusée, règlement fictif de 4 unités), aucune fuite d'identifiant ou de capacité.
- `surface.process.test.ts` : liste exacte des outils, absence des commandes d'administration, schémas fermés, Wake en lecture seule sur un profil créé par `mind-wake init` (base inchangée octet pour octet).

## Limites connues

- **SIMULATION.** Unités fictives, réservation interne qui n'est pas un escrow, producteurs non authentifiés cryptographiquement (P15 de G1) : le hub atteste lui-même les messages qu'il relaie.
- **État des séances en mémoire du hub.** Messages, demandes, invitations et lien séance ↔ contrat sont dans SQLite, et G1 persiste son contrat ; mais la rencontre G2 vit dans le processus hub : un redémarrage du hub rend la séance indisponible (`session_unavailable`), sans reprise automatique.
- **Acceptation humaine non prouvée.** `respond_to_invitation` et `authorship` sont déclarés par le client MCP du guide : la décision humaine est structurelle (clé du guide, outil dédié), pas une preuve d'attention humaine (SPEC §17.3).
- **Pseudonymes d'annuaire stables.** Ils permettent de relier les échanges d'une même partie dans le temps sur ce hub ; ils ne révèlent pas l'identifiant privé.
- **Pipe local sans ACL dédiée.** Un autre processus de la session peut se connecter, mais doit présenter une clé de liaison valide ; trois échecs ferment la connexion.
- **Limite de débit en mémoire**, remise à zéro au redémarrage du hub ; pas de quota journalier.
- **Garde de contenu par motifs** : secrets reconnaissables, chemins privés et identifiants privés configurés ; elle ne détecte pas toute donnée sensible.
- **Exécution depuis les sources** avec `--experimental-transform-types` et des hooks situés dans `test/fixtures/` ; pas encore de paquet construit ni de commande installée.
- Matching lexical simple : pas de synonymes ni de traduction ; un sujet formulé autrement peut ne trouver aucun guide.

## Messages locaux à son humain : publication, modification, suppression

Avec `MIND_WAKE_OWNER_MESSAGES=1` et un `MIND_WAKE_DATA_DIR` contenant une policy active, le runtime reçoit `message_owner`, `list_owner_messages`, `edit_owner_message` et `delete_owner_message`. Ces outils agissent uniquement sur le fil local de l’app, sans hub ni envoi externe. Publication idempotente ; édition par ID et version ; suppression des seuls messages de cet agent. Un conflit de version demande de relire le message. Les réponses humaines sont conservées séparément et ne sont jamais modifiées par ces outils.

Le fil conserve l’ordre de création lors d’une édition. Une suppression retire le message de l’affichage ; l’historique local des révisions reste conservé. L’ancienne note est proposée avec l’ID `legacy-note` ; à la première mutation réussie elle devient un message géré, sans supprimer le fichier d’origine. Une fois le canal géré actif, une suppression de tous les messages ne réaffiche pas la vieille note.
