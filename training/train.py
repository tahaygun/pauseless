import numpy as np, glob, torch, torch.nn as nn, sys, time, json
torch.manual_seed(0); np.random.seed(0)
CH=int(sys.argv[1]) if len(sys.argv)>1 else 24
class Net(nn.Module):
    def __init__(s,ch=CH):
        super().__init__()
        s.c=nn.ModuleList([nn.Conv1d(40,ch,5,padding=2),nn.Conv1d(ch,ch,5,padding=4,dilation=2),
                            nn.Conv1d(ch,ch,5,padding=8,dilation=4),nn.Conv1d(ch,ch,5,padding=16,dilation=8)])
        s.o=nn.Conv1d(ch,1,1)
    def forward(s,x):
        for c in s.c: x=torch.relu(c(x))
        return s.o(x)[:,0]
X=[];Y=[]
for f in sorted(glob.glob('/tmp/cc/ml/ami/*.npz')):
    d=np.load(f); X.append(d['x'].astype(np.float32)); Y.append(d['y'])
for f in sorted(glob.glob('/tmp/cc/ml/hf*.npz')):
    d=np.load(f); k=0
    while f'x{k}' in d: X.append(d[f'x{k}'].astype(np.float32)); Y.append(d[f'y{k}']); k+=1
keep=[i for i in range(len(X)) if len(X[i])>=400]; X=[X[i] for i in keep]; Y=[Y[i] for i in keep]
print('meetings',len(X),'hours',sum(len(x) for x in X)*0.02/3600)
L=400 # 8 s windows
def batch(bs=64):
    xs=[];ys=[]
    for _ in range(bs):
        i=np.random.randint(len(X)); n=len(X[i]); s=np.random.randint(0,max(1,n-L))
        x=X[i][s:s+L]; y=Y[i][s:s+L]
        # augmentation: random gain/tilt in log-mel domain (after norm => small shifts), noise
        x=x+np.random.randn(1,40).astype(np.float32)*0.2+np.random.randn(*x.shape).astype(np.float32)*0.1
        xs.append(x.T); ys.append(y)
    return torch.tensor(np.stack(xs)),torch.tensor(np.stack(ys).astype(np.float32))
net=Net(); opt=torch.optim.Adam(net.parameters(),2e-3)
import copy; ema=copy.deepcopy(net)
print('params',sum(p.numel() for p in net.parameters()))
pf=np.load('/tmp/cc/ml/pf.npy',allow_pickle=True)
def evaluate(th_list=(0.3,0.4,0.5,0.6,0.7,0.8)):
    net.eval(); res={}
    with torch.no_grad():
        P=[torch.sigmoid(net(torch.tensor(x.astype(np.float32).T[None])))[0].numpy() for x in pf[0]]
    net.train()
    lab=json.load(open('/tmp/cc/pf/labels.json'))
    mins=sum(l['dur'] for l in lab)/60
    for th in th_list:
        TP=FP=HIT=NF=0
        for p,l in zip(P,lab):
            fills=[(a,b) for a,b,t,k in l['words'] if t=='filler']; NF+=len(fills)
            ps=np.convolve(p,np.ones(3)/3,'same')>th
            segs=[];s=None
            for t,o in enumerate(np.r_[ps,False]):
                if o and s is None: s=t
                elif not o and s is not None:
                    if t-s>=5: segs.append((s*0.02+0.0125,t*0.02+0.0125))
                    s=None
            got=set()
            for a,b in segs:
                ov=[j for j,(fa,fb) in enumerate(fills) if min(b,fb+0.1)-max(a,fa-0.1)>0]
                if ov: TP+=1; got.update(ov)
                else: FP+=1
            HIT+=len(got)
        Pr=TP/max(1,TP+FP); R=HIT/max(1,NF)
        res[th]=(round(Pr,3),round(R,3),round(2*Pr*R/max(1e-9,Pr+R),3),round(FP/mins,2))
    return res
lossf=nn.BCEWithLogitsLoss(reduction='none')
t0=time.time()
STEPS=int(sys.argv[2]) if len(sys.argv)>2 else 3000
sched=torch.optim.lr_scheduler.OneCycleLR(opt,2e-3,total_steps=STEPS,pct_start=0.1)
for step in range(1,STEPS+1):
    x,y=batch(); out=net(x)
    m=(y>=0).float(); w=torch.where(y>0.5,3.0,1.0)*m
    loss=(lossf(out,y.clamp(0,1))*w).sum()/w.sum()
    opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    with torch.no_grad():
        for pe,pn in zip(ema.parameters(),net.parameters()): pe.mul_(0.998).add_(pn,alpha=0.002)
    if step%1250==0 or step==STEPS:
        live=net; net=ema; r=evaluate(); net=live
        print(step,round(loss.item(),4),round(time.time()-t0),'ema',r, flush=True)
torch.save(ema.state_dict(),f'/tmp/cc/ml/net{CH}.pt')
