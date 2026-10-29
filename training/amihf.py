import pyarrow.parquet as pq, numpy as np, io, soundfile as sf, re, glob, sys, os, collections
sys.path.insert(0,'/tmp/cc/ml'); from mel import logmel, normalize
from data import FILL, IGN
WORDS={}
def words(m):
    if m not in WORDS:
        d={}
        for f in glob.glob(f'/tmp/cc/ami/ann/words/{m}.*.words.xml'):
            L=f.split('.')[-3]
            d[L]=[(float(a),float(b),t.lower()) for a,b,t in re.findall(r'<w [^>]*starttime="([\d.]+)"[^>]*endtime="([\d.]+)"[^>]*>([^<]*)</w>',open(f).read())]
        WORDS[m]=d
    return WORDS[m]
def process(path, out):
    t=pq.read_table(path)
    groups=collections.defaultdict(list)
    n=t.num_rows
    for k in range(0,n,256):
        for r in t.slice(k,256).to_pylist():
            a=r['audio']; x,sr=sf.read(io.BytesIO(a['bytes']),dtype='float32')
            if x.ndim>1:x=x.mean(1)
            M=logmel(x,sr)
            if len(M)<10: continue
            b0,e0=r['begin_time'],r['end_time']; toks=set(r['text'].lower().split())
            best=None;bs=-1
            for L,ws in words(r['meeting_id']).items():
                inw=[w for w in ws if w[0]>=b0-0.3 and w[1]<=e0+0.3]
                sc=len(toks & set(w[2] for w in inw))
                if sc>bs: bs=sc;best=inw
            y=np.zeros(len(M),np.int8); hop=0.02; c0=0.0125
            for st,en,w in best or []:
                v=1 if w in FILL else (-1 if w in IGN else 0)
                if v==0: continue
                i0=max(0,int(np.ceil((st-b0-c0)/hop))); i1=min(len(M),int(np.floor((en-b0-c0)/hop))+1)
                y[i0:i1]=np.where(y[i0:i1]==1,1,v)
            groups[(r['meeting_id'],r['speaker_id'])].append((b0,M,y))
    X=[];Y=[]
    for key,us in groups.items():
        us.sort(key=lambda u:u[0])
        allM=np.concatenate([u[1] for u in us])
        X.append(normalize(allM).astype(np.float16)); Y.append(np.concatenate([u[2] for u in us]))
    np.savez_compressed(out,**{f'x{i}':x for i,x in enumerate(X)},**{f'y{i}':y for i,y in enumerate(Y)})
    print(out,len(X),sum(len(x) for x in X)*0.02/3600,'h',np.mean(np.concatenate(Y)==1))
if __name__=='__main__':
    process(sys.argv[1],sys.argv[2])
