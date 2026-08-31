# Retrieval eval set

Two files. One grades the product, the other is a queue of things nobody has
ruled on yet.

| file | what it is |
|---|---|
| `retrieval-pairs.json` | Reviewed pairs. This is what `npm run eval:retrieval` grades. |
| `retrieval-candidates.json` | Harvested from real citations, awaiting a human. Not graded. |

## Why they live here and not in a scratch folder

These twelve pairs decided whether query expansion shipped, and which trigger it
shipped with. A measurement that gates a production decision has to be
reviewable in a pull request, or the decision rests on a file that only one
machine has ever seen.

## Running it

```
npm run eval:retrieval
```

It refuses to run without an embedding deployment rather than grading the
keyword half and calling the number recall. Set `EXPAND=1` to grade with query
expansion on.

## Reviewing a candidate

Move it into `retrieval-pairs.json` with `reviewed: true`, or delete it. A pair
is good when a person asked a real question and one document genuinely answers
it. It is bad when:

- **The question is the filename.** Retrieval cannot fail it, so it measures
  nothing and inflates every score it appears in.
- **It is not a question.** There is no right document to find.
- **The answer lives in another system.** Grading document retrieval on a
  calendar question scores the wrong thing.
- **No single document answers it.** "What is in SharePoint" has no target, so
  the pair grades noise.

The harvester finds candidates by looking at what got cited, which is a good
signal and not a sufficient one: somebody having opened a file in the same
session is not the same as that file answering the question.

## Size

Twelve is enough to catch a large regression and not enough to calibrate a
threshold. The keyword-score floor that would close the gap between the
conservative and loose expansion triggers needs a set several times this size,
which is the main reason to keep reviewing candidates.
