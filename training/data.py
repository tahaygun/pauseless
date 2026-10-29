import numpy as np, re, glob, os, soundfile as sf, json, sys
sys.path.insert(0,'/tmp/cc/ml'); from mel import *
FILL={'um','uh','hmm','mm','ah','eh','er','uhm','erm'}
IGN={'mm-hmm','uh-huh','mm-mm','um-hmm'}
HOP=0.02
def ami_words(m):
    out=[]
    for f in glob.glob(f'/tmp/cc/ami/ann/words/{m}.*.words.xml'):
        for st,en,txt in re.findall(r'<w [^>]*starttime="([\d.]+)"[^>]*endtime="([\d.]+)"[^>]*>([^<]*)</w>',open(f).read()):
            out.append((float(st),float(en),txt.lower()))
    return out
def labels(n,words,t0):
    y=np.zeros(n,np.int8)  # 0 other, 1 filler, -1 ignore
    t=t0+np.arange(n)*HOP
    for st,en,w in words:
        if w in FILL: v=1
        elif w in IGN: v=-1
        else: continue
        i0=max(0,int(np.ceil((st-t0)/HOP))); i1=min(n,int(np.floor((en-t0)/HOP))+1)
        y[i0:i1]=np.where(y[i0:i1]==1,1,v)
    return y
def build_ami():
    os.makedirs('/tmp/cc/ml/ami',exist_ok=True)
    for p in sorted(glob.glob('/tmp/cc/ami/audio/*.wav')):
        m=os.path.basename(p)[:-4]; out=f'/tmp/cc/ml/ami/{m}.npz'
        if os.path.exists(out): continue
        try: x,sr=sf.read(p,dtype='float32')
        except Exception as e: print('skip',m,e); continue
        if x.ndim>1:x=x.mean(1)
        M=normalize(logmel(x,sr)); win=round(0.025*sr)
        y=labels(len(M),ami_words(m),win/2/sr)
        np.savez_compressed(out,x=M.astype(np.float16),y=y); print(m,len(M),(y==1).mean().round(4))
def build_pf():
    lab=json.load(open('/tmp/cc/pf/labels.json')); X=[];Y=[]
    for L in lab:
        x,sr=sf.read(f'/tmp/cc/pf/clips/{L["i"]}.wav',dtype='float32')
        M=normalize(logmel(x,sr)); win=round(0.025*sr)
        words=[(a,b,('um' if t=='filler' else 'word')) for a,b,t,k in L['words']]
        X.append(M.astype(np.float16)); Y.append(labels(len(M),words,win/2/sr))
    np.save('/tmp/cc/ml/pf.npy',np.array([X,Y],dtype=object),allow_pickle=True)
if __name__=='__main__':
    build_ami() if sys.argv[1]=='ami' else build_pf()
