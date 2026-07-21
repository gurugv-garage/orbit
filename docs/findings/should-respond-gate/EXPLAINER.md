# The should-respond gate: what I did, how, and why

A plain-language walkthrough of the experiment — what problem, what I built, what
worked, what didn't, and the concepts you'd want to read up on. No prior ML
background assumed.

---

## 1. The problem, in one paragraph

The dock hears every sound in the room and transcribes it (STT). But most of what
it hears is **not for it** — people talking to each other, background chatter,
half-words, garbled transcription. Today the dock decides "is this for me?" with
hand-written rules (a conversation-window timer + tap-to-address), and it gets it
wrong in two ways we've seen: it **answers overheard room chatter** (the "sat in a
meeting for 1.5M tokens" bug) and sometimes **misses real commands**. The idea:
put a tiny, fast, local model at the STT output that judges **"should the dock
respond to this utterance?"** — in under 100ms, before anything else fires.

Output we want: a yes/no **should_respond** plus a **confidence** (0..1).

---

## 2. What data I used (all real, all on-disk)

Everything came from files the dock already writes — no new capture, no simulation:

- **The utterances**: `orbit-station/server/.data/perception/records/dock-redmi/<date>.jsonl`
  — every STT transcription the dock made, with text, timestamp, confidence tier,
  and a voice-fingerprint guess of who spoke.
- **The conversation context**: `.data/brain/dock-redmi/<session>.json` — the
  actual back-and-forth transcripts, so for each utterance I could reconstruct
  "what was being said around it."

I built a corpus of **178 utterances, each paired with the conversation context it
landed in**. Then I **labeled each one myself** — reading it in context and
deciding should_respond yes/no. That hand-labeling is the heart of it: those labels
are the "right answers" everything else is measured against. (Only ~20% were
genuinely addressed to the dock — the room mostly isn't talking to it.)

**Why label them myself instead of using another AI?** Because I have to be able to
stand behind the target. If I farm the judgment to another model, I'm optimizing
toward *its* opinion, not a ground truth I've verified.

---

## 3. The two approaches I tried (this is the crux)

Both approaches use the same small language model (Qwen3-0.6B — "0.6B" = 600 million
parameters, tiny by LLM standards, runs locally on the Mac in tens of milliseconds).
The difference is **how you get a yes/no decision out of it.**

### Approach A — "generative fine-tuning" (the intuitive one; it FAILED)

A language model's native ability is **predicting the next word**. So the obvious
idea: show it the utterance and train it to literally type the word **"Yes"** or
**"No"** as its next word.

- **Fine-tuning** = taking a pre-trained model and nudging its weights on your own
  examples so it behaves the way you want. **LoRA** is the cheap, popular way to do
  it (you train a small add-on instead of the whole model). I also tried a **full
  fine-tune** (adjust every weight).
- I ran **five variants** — different prompts, balanced vs unbalanced data, a full
  fine-tune. **Every one failed**: on held-out utterances it was no better than a
  coin flip (AUC ~0.50).

**Why it failed** (the important insight): when you train a model to output "Yes" or
"No" and 80% of your answers are "No", the model discovers a lazy shortcut — *always
lean No* — which makes the training score look great while the model completely
ignores the actual utterance. The training math (the "loss") went down, but the
model learned the **overall ratio** of yes-to-no, not the **mapping from utterance
to answer**. It literally gave the same score to "Hey Orbit, wish Rhea happy
birthday" and to a garbled "The bone." I confirmed this wasn't a bug in my code by
running a **control**: I trained the identical pipeline on a trivial task ("does the
utterance contain the word 'orbit'?") and it worked fine (AUC 0.80). So the
machinery was sound — the *generative approach* to this task was the problem.

### Approach B — "classifier head on frozen features" (it WORKED, AUC 0.94)

This is the part you asked about. Two concepts:

**"Frozen features" / embeddings.** When a language model reads text, before it ever
picks a next word it builds up an internal numerical summary of what it just read —
a long list of numbers (here, 1024 of them) called a **hidden state** or
**embedding**. Think of it as the model's compressed understanding of the utterance
and its context. "Frozen" means I **don't change the model at all** — I just run the
utterance through it and grab that 1024-number summary. One forward pass, no
training of the big model.

**"Classifier head" / linear probe.** On top of those 1024 numbers I train a tiny,
separate, dead-simple model — **logistic regression**. All it does is learn a
weighted sum: multiply each of the 1024 numbers by a learned weight, add them up,
squash the result to a 0..1 probability. That's the whole "head." It's called
**linear** because it's just a weighted sum (no deep layers), and a **probe**
because it's testing "is the answer already sitting in these numbers, in a simple
form?"

**The result: yes, overwhelmingly.** The classifier head hit **AUC 0.94** — from the
*same 35 positive examples* that the generative approach couldn't learn from at all.

**Why does B work where A failed?** Because the model's *understanding* of "is this
addressed to me?" was **already present** in the frozen hidden state — the
information was there all along. The generative approach couldn't *reach* it because
the "always say No" shortcut got in the way. The classifier head reads the
understanding directly and can't take that shortcut — it's forced to find the actual
pattern in the 1024 numbers that separates yes from no. And because it's so simple
(just a weighted sum), it learns from very few examples.

---

## 4. How I know it's real (not a fluke on 35 examples)

Small data is easy to fool yourself with, so I stress-tested the 0.94:

- **Cross-validation.** Instead of one train/test split, I split the data many ways,
  each time training on most of it and testing on the part held out, then pooled the
  results. This is the standard defense against "you got lucky with one split."
  - **Repeated 5-fold** (10 different random splits): AUC 0.93–0.95.
  - **Leave-one-out** (train on 177, predict the 1 left out, 178 times): 0.93.
- **Eyeball check.** The top-ranked utterances are all real commands ("Hey, orbit",
  "find the coffee cup", "Stop talking"); the bottom are all room chatter/garble
  ("[overheard family chatter]", "[garbled fragment]"). It's separating the *right* thing.
- **Latency.** Full gate (one base forward pass + the weighted sum) = **31ms**, a
  third of the 100ms budget.

**AUC**, since it's everywhere here: "Area Under the ROC Curve." Plain meaning — take
one random should-respond utterance and one random should-not; AUC is the
probability the model scores the first higher. 0.50 = coin flip, 1.00 = perfect.
0.94 = it ranks them correctly 94% of the time.

---

## 5. What to read up on (in rough order)

1. **Embeddings / hidden states** — "what is a text embedding" — the 1024-number
   summary is the whole foundation. (Search: "sentence embeddings intuition",
   "transformer hidden states".)
2. **Linear probing** — "linear probe neural network representations" — the exact
   technique in Approach B: freeze the big model, train a linear classifier on its
   internal features to test what it already encodes.
3. **Logistic regression** — the "classifier head" itself; the simplest useful
   classifier. (Search: "logistic regression intuition".)
4. **Fine-tuning vs feature extraction** — "fine-tuning vs linear probing" — the A
   vs B distinction; there's a well-known literature on when each wins (and probing
   winning on small data is a known result).
5. **LoRA** — "LoRA fine-tuning explained" — the cheap fine-tuning method that
   Approach A used.
6. **AUC / ROC** — "ROC AUC explained simply" — the metric.
7. **Class imbalance & the majority-class trap** — "why accuracy is misleading
   imbalanced data" — exactly the shortcut that sank Approach A.

---

## 6. One-line summary

I labeled 178 real dock utterances for "should I respond?", found that *teaching the
model to say Yes/No* fails (it learns to always say the common answer), but *reading
the model's own internal understanding with a tiny classifier* works at 0.94 accuracy
and 31ms — because the model already knew; it just couldn't say it.
