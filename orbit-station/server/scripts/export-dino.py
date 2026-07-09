import torch, warnings, os; warnings.filterwarnings("ignore")
base = torch.hub.load("facebookresearch/dinov2","dinov2_vits14",verbose=False).eval()
class Wrap(torch.nn.Module):
    def __init__(s,m): super().__init__(); s.m=m
    def forward(s,img): return s.m(img)   # CLS token, 384-d — image input only
w = Wrap(base).eval()
torch.onnx.export(w, torch.randn(1,3,224,224), "models/embed/dinov2_vits14.onnx",
    input_names=["img"], output_names=["emb"],
    dynamic_axes={"img":{0:"b"},"emb":{0:"b"}}, opset_version=17)
print("exported", os.path.getsize("models/embed/dinov2_vits14.onnx")//1_000_000, "MB")
