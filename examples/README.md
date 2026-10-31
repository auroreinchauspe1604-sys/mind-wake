# Modèle full access local

`AUTORISATIONS.full-access.template.json` couvre le filesystem accessible au compte
du propriétaire et les sous-agents des runtimes déjà autorisés, sans nouvelle
validation humaine pour chaque tâche couverte. Sa présence dans le dépôt ne change
aucune installation.

Pour une adoption locale explicitement décidée par le propriétaire :

```powershell
node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./test/fixtures/store-ledger/ts-hooks.ts scripts/setup-agent-autonomy.mjs --workspace C:/atelier --data-dir C:/wake-data --owner "Propriétaire" --agent agent-bbbbbbbbbb --adopt
```

Le script sauvegarde la version antérieure et conserve les autres restrictions
personnelles. Pour les propositions de travail entre ateliers, ajouter l'endpoint
du hub déjà choisi et le fichier local contenant sa clé :

```powershell
# Ajouter aux arguments précédents :
--peer-endpoint https://hub.example.invalid/v1/messages --peer-key-file C:/private/shared.key
```

Le décideur local est alors l'agent, et les outils de décision sont exposés au
prochain lancement de son MCP MIND. L'agent accepte ou refuse les propositions
selon son mandat, choisit une session autorisée puis supervise le travail ; aucun
accord humain supplémentaire par tâche n'est imposé. La configuration native du
runtime et les scopes filesystem distants ne sont pas modifiés par ce script.
