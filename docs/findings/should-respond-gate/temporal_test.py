#!/usr/bin/env python3
"""
Temporal generalization test: train the classifier head on MORNING utterances only,
predict the AFTERNOON slice (>=11:37 IST) that was unseen and unlabeled at train time.
This mimics deployment (train on past, predict future) — harder & more honest than CV.

Morning labels come from labels_full.py (my original 178, all <11:37).
Afternoon labels come from labels_afternoon.py (the 81 new ones).
Features are the frozen-base last-token hidden state (same as extract_features.py).
"""
import json, os, re, sys
import numpy as np
import mlx.core as mx
from mlx_lm import load

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)
from labels_afternoon import LABELS as AFT

BASE = "Qwen/Qwen3-0.6B"
CUT_MS = 1784613420000  # 2026-07-21T11:37 IST in ms (approx; recomputed below)
import datetime
CUT_MS = int(datetime.datetime.fromisoformat("2026-07-21T11:37:00+05:30").timestamp()*1000)

def last3(ctx):
    if not ctx: return ''
    return ' / '.join((('U:' if x['role']=='user' else 'D:') +
        re.sub(r'\[face:[a-z]+\]\s*','',x['text']).strip()[:80]) for x in ctx[-3:])

def prompt(o):
    return ('Conversation so far: %s\nNew utterance heard: "%s"\n'
            'Question: was this spoken to the robot?') % (last3(o["context"]), o["text"])

def feat(model, tok, o):
    ids = tok.encode(prompt(o))
    h = model.model(mx.array([ids]))[0,-1,:].astype(mx.float32); mx.eval(h)
    return np.array(h)

def main():
    corpus = [json.loads(l) for l in open(os.path.join(HERE,"coherence_corpus.jsonl"))]
    withctx = [r for r in corpus if r["context"]]
    morning = sorted([r for r in withctx if r["ts_ms"] <  CUT_MS], key=lambda x:x["ts_ms"])
    after   = sorted([r for r in withctx if r["ts_ms"] >= CUT_MS], key=lambda x:x["ts_ms"])
    print(f"morning={len(morning)}  afternoon={len(after)}", file=sys.stderr)

    # morning labels: re-judge via labels_full mapping? labels_full is keyed by the
    # ORIGINAL 178 order. Safer: reuse labeled_set.jsonl (has label per text+idx) by matching text+ts.
    labeled = {(*[c['text'] for c in o['context'][-1:]], o['text']): o['label_respond']
               for o in (json.loads(l) for l in open(os.path.join(HERE,"labeled_set.jsonl")))}
    def morn_label(r):
        k = (*[c['text'] for c in r['context'][-1:]], r['text'])
        return labeled.get(k)

    print(f"loading {BASE}...", file=sys.stderr)
    model, tok = load(BASE)

    # build morning train (features + labels)
    Xtr, ytr = [], []
    miss = 0
    for r in morning:
        lb = morn_label(r)
        if lb is None: miss += 1; continue
        Xtr.append(feat(model, tok, r)); ytr.append(lb)
    Xtr = np.stack(Xtr); ytr = np.array(ytr, float)
    print(f"morning train: {Xtr.shape}, pos={int(ytr.sum())}, unmatched-labels={miss}", file=sys.stderr)

    # afternoon test (features + MY new labels, by A## order)
    Xte, yte, texts = [], [], []
    for i, r in enumerate(after):
        if i not in AFT: continue
        Xte.append(feat(model, tok, r)); yte.append(AFT[i][0]); texts.append(r["text"])
    Xte = np.stack(Xte); yte = np.array(yte, float)
    print(f"afternoon test: {Xte.shape}, pos={int(yte.sum())}", file=sys.stderr)

    # standardize on TRAIN stats only (no leakage)
    mu, sd = Xtr.mean(0), Xtr.std(0)+1e-6
    Xtr_s = (Xtr-mu)/sd; Xte_s = (Xte-mu)/sd

    def sig(z): return 1/(1+np.exp(-z))
    def lr(X,y,l2=1.0,it=600):
        w=np.zeros(X.shape[1]);b=0.;m=len(y)
        for _ in range(it):
            p=sig(X@w+b);g=p-y; w-=0.1*(X.T@g/m+l2*w/m); b-=0.1*g.mean()
        return w,b
    def auc(s,l):
        p=[a for a,b in zip(s,l) if b]; q=[a for a,b in zip(s,l) if not b]
        return sum((a>b)+0.5*(a==b) for a in p for b in q)/(len(p)*len(q)) if p and q else None

    w,b = lr(Xtr_s, ytr, l2=1.0)
    tr_auc = auc(sig(Xtr_s@w+b), ytr)
    te_scores = sig(Xte_s@w+b)
    te_auc = auc(te_scores, yte)
    print(f"\n=== TEMPORAL: train on MORNING, test on AFTERNOON ===")
    print(f"train-fit AUC (morning): {tr_auc:.3f}")
    print(f"TEST AUC (afternoon, unseen): {te_auc:.3f}   n={len(yte)}, pos={int(yte.sum())}")

    # confusion at a few thresholds
    for thr in (0.4,0.5,0.6):
        pred=te_scores>=thr
        tp=int(((pred)&(yte==1)).sum()); fp=int(((pred)&(yte==0)).sum())
        tn=int(((~pred)&(yte==0)).sum()); fn=int(((~pred)&(yte==1)).sum())
        print(f"  thr={thr}: acc={(tp+tn)/len(yte):.2f} tp={tp} fp={fp} tn={tn} fn={fn}")

    order=np.argsort(-te_scores)
    print("\ntop-10 afternoon by score (want addressed=1):")
    for i in order[:10]: print(f"  P={te_scores[i]:.2f} y={int(yte[i])}  {texts[i][:46]}")
    print("bottom-10 (want addressed=0):")
    for i in order[-10:]: print(f"  P={te_scores[i]:.2f} y={int(yte[i])}  {texts[i][:46]}")

    # save for the record
    np.savez(os.path.join(HERE,"temporal_result.npz"),
             te_scores=te_scores, yte=yte, te_auc=te_auc)

if __name__ == "__main__":
    main()
