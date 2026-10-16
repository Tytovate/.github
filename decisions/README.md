# decisions: check en index voor besluitenmappen

De herbruikbare check uit [team/0001](https://github.com/Tytovate/tyto-docs/blob/main/decisions/0001-een-documentatiestandaard-voor-alle-repos.md)
("Bevestiging"). Een PR faalt bij:

| Regel | Veld in de fout |
| --- | --- |
| Ongeldige front matter: `status` (voorgesteld \| geaccepteerd \| afgewezen), `datum` (JJJJ-MM-DD), `besluitnemers`, `raakt`; optioneel `geraadpleegd`, `vervangt` (id of `{id, deels}`); geen andere sleutels; kop `# NNNN: titel` | de sleutel, bijv. `datum`, `vervangt[0].deels`, `titel` |
| Een dubbel nummer | `nummer` (noemt alle bestanden) |
| Een gewijzigd, verwijderd of hernoemd geaccepteerd besluit (voorgesteld → geaccepteerd mag) | `inhoud` / `bestand` |
| Een `vervangt` naar een besluit dat niet bestaat | `vervangt[i]` |
| Een PR die de map wijzigt en niet naar de standaardbranch gaat | `doelbranch` |
| Een ontbrekende of verouderde `index.md` | `index` |

## Aanroepen

```yaml
# .github/workflows/decisions.yml in de repo met besluiten
name: decisions
on:
  pull_request:
permissions:
  contents: read
jobs:
  decisions:
    uses: Tytovate/.github/.github/workflows/decisions-check.yml@main
    with:
      dir: decisions        # paperclip: tyto-docs/adr
      prefix: team          # paperclip: paperclip
    # secrets:
    #   token: ${{ secrets.DECISIONS_READ_TOKEN }}   # optioneel, zie hieronder
```

## De index genereren

De index komt uit de front matter; commit hem in dezelfde PR als het besluit:

```sh
npx --yes -p github:Tytovate/.github decisions index --dir decisions --prefix team
```

Lokaal controleren zoals CI (zonder `--base` vallen de regels over git weg):

```sh
npx --yes -p github:Tytovate/.github decisions check --dir decisions --prefix team --base origin/main --base-ref main --default-branch main
```

## Wat niet gecontroleerd wordt

- **`vervangt` naar een andere repo zonder token.** Een id met een ander prefix (bijv. `paperclip/0001`
  vanuit `team`) geeft dan een waarschuwing "niet gecontroleerd", geen fout. Met `secrets.token`
  (alleen leesrecht op contents) zoekt de check het nummer op in de map van die repo:
  `team` → `Tytovate/tyto-docs:decisions`, `paperclip` → `Tytovate/paperclip:tyto-docs/adr`,
  anders `Tytovate/<prefix>:docs/decisions`. Afwijkend? Geef `sources: "prefix=owner/repo:map"`.
- **Vervanging over repo's heen in de index.** Een index leidt "vervangen" alleen af uit besluiten
  in dezelfde map; dat team/0001 paperclip/0001 deels vervangt, staat niet in de index van paperclip.
- **Wat er in een besluit staat.** De check leest alleen front matter, nummer en kop.
