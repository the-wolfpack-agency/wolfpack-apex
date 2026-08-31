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

## Where candidates come from

```
npx tsx scripts/generate-eval-pairs.ts --count 60
```

It takes a passage from a document and asks a model what question that passage
answers. The correct document is known by construction, because we chose the
passage. There is no inference and nothing to be wrong about.

**This replaced harvesting from the query log.** That version paired a question
with whichever document got cited near it, which is a real signal and not a
sufficient one: somebody having a file open is not the same as that file
answering the question. On this corpus it produced a test Salesforce account as
its top candidate on 52 citations, two screenshots against calendar questions,
and a video playlist against "whats in sharepoint". Five of six were unusable.

**A public benchmark would not help.** BEIR, MS MARCO and NQ score retrieval
over their own corpora. How well we find a Wikipedia paragraph says nothing
about whether we find a client's work order, and retrieval quality is
corpus-specific.

**It does not check its own answers by retrieving them.** Keeping only the
pairs the product already finds would make the eval agree with the product by
construction, and the number would rise every time retrieval got narrower. A
test set has to be able to fail.

## Reviewing a candidate

Each one carries the passage its question came from and the answer that passage
gives, so the decision takes seconds. Move it into `retrieval-pairs.json` with
`reviewed: true`, or delete it.

The generator already rejects the three ways a pair is worthless (see
`pair-quality.ts`), so what is left for a person is the judgment a rule cannot
make: would somebody actually ask this, and does the document really answer it
rather than merely mention it.

Rejected automatically:

- **The question restates the filename.** Retrieval cannot fail it, so it
  measures nothing and inflates every score it appears in.
- **The document has near-identical siblings.** Ten cohort survey exports
  answer a survey question equally well, so naming one marks a tie as a miss.
- **Two questions describe the same thing and name different files.** Both
  courses run the same closing activity; whichever the retriever finds, one
  pair would mark it wrong. Both are dropped.

## Size

Twelve is enough to catch a large regression and not enough to calibrate a
threshold. The keyword-score floor that would close the gap between the
conservative and loose expansion triggers needs a set several times this size,
which is the main reason to keep reviewing candidates.

The corpus supports about 46 documents worth asking about: 884 indexed, minus
receipts, screenshots, invoices, flight bookings and video, minus anything with
fewer than five chunks, minus every member of a near-identical family. That is
the ceiling on a one-question-per-document set built this way.
