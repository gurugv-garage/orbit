#!/usr/bin/env python3
"""
Linear-probe the frozen-base features: does a classifier head separate the
addressed task where generative fine-tuning could not?

Small data (178 rows, 35 pos) -> stratified K-fold cross-val so every point gets an
out-of-fold prediction; report pooled AUC. Compare against the generative ceiling
(0.52) and the trivial-control ceiling (0.80). No sklearn dependency assumed -> pure
numpy logistic regression with L2.
"""
import os, json, numpy as np

HERE = os.path.dirname(__file__)
d = np.load(os.path.join(HERE, "features.npz"))
F, y = d["F"], d["y"].astype(np.float64)
idx = d["idx"]
n, dim = F.shape

# standardize features
mu, sd = F.mean(0), F.std(0) + 1e-6
X = (F - mu) / sd

def sigmoid(z): return 1/(1+np.exp(-z))

def train_lr(Xtr, ytr, l2=1.0, iters=500, lr=0.1):
    w = np.zeros(Xtr.shape[1]); b = 0.0
    m = len(ytr)
    for _ in range(iters):
        p = sigmoid(Xtr@w + b)
        g = p - ytr
        gw = Xtr.T@g/m + l2*w/m
        gb = g.mean()
        w -= lr*gw; b -= lr*gb
    return w, b

def stratified_folds(y, k=5):
    pos = np.where(y==1)[0]; neg = np.where(y==0)[0]
    folds = [[] for _ in range(k)]
    for i, p in enumerate(pos): folds[i%k].append(p)
    for i, q in enumerate(neg): folds[i%k].append(q)
    return [np.array(sorted(f)) for f in folds]

def auc(scores, labels):
    p=[s for s,l in zip(scores,labels) if l]; q=[s for s,l in zip(scores,labels) if not l]
    return sum((a>b)+0.5*(a==b) for a in p for b in q)/(len(p)*len(q))

def main():
    print(f"features {X.shape}, positives {int(y.sum())}\n")
    for l2 in (0.3, 1.0, 3.0, 10.0):
        oof = np.zeros(n)
        folds = stratified_folds(y, k=5)
        for f in folds:
            mask = np.ones(n, bool); mask[f] = False
            w, b = train_lr(X[mask], y[mask], l2=l2)
            oof[f] = sigmoid(X[f]@w + b)
        a = auc(oof, y)
        # accuracy at best threshold
        best=0; bthr=0.5
        for t in [i/50 for i in range(1,50)]:
            acc=((oof>=t)==(y==1)).mean()
            if acc>best: best=acc; bthr=t
        print(f"L2={l2:5.1f}:  5-fold OOF AUC = {a:.3f}   best-acc={best:.2f}@thr{bthr:.2f}")

    # train on all, show top-confidence predictions for eyeballing
    w, b = train_lr(X, y, l2=1.0)
    scores = sigmoid(X@w + b)
    rows = [json.loads(l) for l in open(os.path.join(HERE,"labeled_set.jsonl"))]
    order = np.argsort(-scores)
    print("\ntop-12 by probe score (want addressed=1 up top):")
    for i in order[:12]:
        print(f"  P={scores[i]:.2f} y={int(y[i])}  {rows[int(np.where(idx==idx[i])[0][0])]['text'][:44] if False else rows[i]['text'][:44]}")
    print("\nbottom-8 (want addressed=0):")
    for i in order[-8:]:
        print(f"  P={scores[i]:.2f} y={int(y[i])}  {rows[i]['text'][:44]}")

    print(f"\nreference: generative tuned ceiling=0.52, trivial control=0.80")

if __name__ == "__main__":
    main()
