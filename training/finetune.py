# Fine-tunes the AMI filler model on a corrected recording.
# Input tr.npz: x = normalized log-mel frames (mel.py), y = per-frame labels (1 filler, 0 not, -1 ignore),
# fills = filler ranges in seconds. Built from a Pauseless timeline export whose cuts the user corrected:
# cuts that hold speech energy are fillers. Usage: finetune.py ft <steps> <share of Turkish batches>
import numpy as np, sys, torch, json, copy
src=open('/tmp/cc/ml/train.py').read()
head,rest=src.split('L=400')
head=head.replace('CH=int(sys.argv[1]) if len(sys.argv)>1 else 24','CH=32')
exec(head)  # Net, X, Y (AMI)
T=np.load('tr.npz'); TX=T['x'].astype(np.float32); TY=T['y']; fills=T['fills']
SPLIT=int(1900/0.02)
def ev(net,x,fl,t0):
    with torch.no_grad(): p=torch.sigmoid(net(torch.tensor(x.T[None])))[0].numpy()
    out={}
    for th in (0.4,0.5,0.6,0.65,0.7,0.8):
        ps=np.convolve(p,np.ones(3)/3,'same')>th; segs=[];s=None
        for t,o in enumerate(np.r_[ps,False]):
            if o and s is None: s=t
            elif not o and s is not None:
                if t-s>=5: segs.append((t0+s*0.02,t0+t*0.02+0.025))
                s=None
        TP=FP=0; got=set()
        for a,b in segs:
            ov=[j for j,(fa,fb) in enumerate(fl) if min(b,fb+0.1)-max(a,fa-0.1)>0]
            if ov: TP+=1; got.update(ov)
            else: FP+=1
        P=TP/max(1,TP+FP); R=len(got)/max(1,len(fl)); mins=len(x)*0.02/60
        out[th]=(round(P,2),round(R,2),round(2*P*R/max(1e-9,P+R),2),round(FP/mins,1))
    return out
testfl=[f for f in fills if f[0]>=1900]
net=Net(); net.load_state_dict(torch.load('/tmp/cc/ml/net32.pt')); net.eval()
print('baseline TR test',ev(net,TX[SPLIT:],testfl,1900))
if len(sys.argv)>1 and sys.argv[1]=='base': sys.exit()
mode=sys.argv[1] if len(sys.argv)>1 else 'ft'
STEPS=int(sys.argv[2]) if len(sys.argv)>2 else 1500
PT=float(sys.argv[3]) if len(sys.argv)>3 else 0.5
if mode=='scratch': net=Net()
net.train(); ema=copy.deepcopy(net)
trX=TX[:SPLIT]; trY=TY[:SPLIT]; L=400
def sample(x,y):
    s=np.random.randint(0,len(x)-L); xx=x[s:s+L]
    xx=xx+np.random.randn(1,40).astype(np.float32)*0.2+np.random.randn(*xx.shape).astype(np.float32)*0.1
    return xx.T,y[s:s+L]
def batch(bs=64):
    xs=[];ys=[]
    for _ in range(bs):
        if np.random.rand()<PT: a,b=sample(trX,trY)
        else:
            i=np.random.randint(len(X))
            while len(X[i])<=L: i=np.random.randint(len(X))
            a,b=sample(X[i],Y[i])
        xs.append(a); ys.append(b)
    return torch.tensor(np.stack(xs)),torch.tensor(np.stack(ys).astype(np.float32))
lr=2e-3 if mode=='scratch' else 5e-4
opt=torch.optim.Adam(net.parameters(),lr)
sched=torch.optim.lr_scheduler.OneCycleLR(opt,lr,total_steps=STEPS,pct_start=0.1)
lossf=torch.nn.BCEWithLogitsLoss(reduction='none')
for step in range(1,STEPS+1):
    x,y=batch(); out=net(x)
    m=(y>=0).float(); w=torch.where(y>0.5,3.0,1.0)*m
    loss=(lossf(out,y.clamp(0,1))*w).sum()/w.sum()
    opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    with torch.no_grad():
        for pe,pn in zip(ema.parameters(),net.parameters()): pe.mul_(0.995).add_(pn,alpha=0.005)
    if step%500==0 or step==STEPS:
        ema.eval(); print(step,'TR test',ev(ema,TX[SPLIT:],testfl,1900),flush=True); ema.train()
ema.eval(); torch.save(ema.state_dict(),f'tr_{mode}_{STEPS}_{PT}.pt')
