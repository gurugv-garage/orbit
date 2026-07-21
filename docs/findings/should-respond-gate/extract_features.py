#!/usr/bin/env python3
"""
Extract frozen-base hidden-state features for each utterance, for a classifier head.

For each row: run the base model over the prompt, take the LAST-token hidden state
from the final layer (the model's summary representation at the decision point).
Save features + labels as .npy. One forward pass per row, no generation.

This tests: are the addressed representations PRESENT in the frozen base (just not
reachable via next-token generation)? A linear probe answers that directly.
"""
import json, os, sys, re
import numpy as np
import mlx.core as mx
from mlx_lm import load

HERE = os.path.dirname(__file__)
BASE = sys.argv[1] if len(sys.argv) > 1 else "Qwen/Qwen3-0.6B"

def last2(ctx):
    if not ctx: return ''
    return ' / '.join((('U:' if x['role']=='user' else 'D:') +
        re.sub(r'\[face:[a-z]+\]\s*','',x['text']).strip()[:80]) for x in ctx[-3:])

def prompt(o):
    # richer context (3 lines) since we're pooling, not generating
    return ('Conversation so far: %s\nNew utterance heard: "%s"\n'
            'Question: was this spoken to the robot?') % (last2(o["context"]), o["text"])

def main():
    print(f"loading {BASE} for feature extraction...", file=sys.stderr)
    model, tok = load(BASE)

    rows = [json.loads(l) for l in open(os.path.join(HERE, "labeled_set.jsonl"))]

    feats, labels, idxs, confs = [], [], [], []
    for o in rows:
        ids = tok.encode(prompt(o))
        x = mx.array([ids])
        # run model to get hidden states: model(x) returns logits, so we tap the
        # base transformer output via model.model(...) (the pre-lm_head hidden states)
        h = model.model(x)                 # [1, seq, hidden]
        last = h[0, -1, :].astype(mx.float32)   # last-token hidden state, cast f32
        mx.eval(last)
        feats.append(np.array(last))
        labels.append(o["label_respond"])
        idxs.append(o["idx"])
        confs.append(o["label_confidence"])

    F = np.stack(feats)
    y = np.array(labels, dtype=np.int32)
    print(f"features: {F.shape}  labels: {y.shape}  positives: {int(y.sum())}", file=sys.stderr)
    np.savez(os.path.join(HERE, "features.npz"),
             F=F, y=y, idx=np.array(idxs), conf=np.array(confs))
    print(f"saved features.npz  (dim={F.shape[1]})")

if __name__ == "__main__":
    main()
