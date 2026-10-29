# Reference log-mel features. src/engine/mel.ts must match this exactly.
import numpy as np
NB=40; FMIN=60.0; FMAX=7600.0
def hz2mel(f): return 2595*np.log10(1+f/700)
def mel2hz(m): return 700*(10**(m/2595)-1)
def params(sr):
    win=round(0.025*sr); hop=round(0.020*sr); nfft=1
    while nfft<win: nfft*=2
    return win,hop,nfft
def fbank(sr):
    win,hop,nfft=params(sr)
    e=mel2hz(np.linspace(hz2mel(FMIN),hz2mel(FMAX),NB+2))
    f=np.arange(nfft//2+1)*sr/nfft
    W=np.zeros((NB,len(f)))
    for b in range(NB):
        W[b]=np.maximum(0,np.minimum((f-e[b])/(e[b+1]-e[b]),(e[b+2]-f)/(e[b+2]-e[b+1])))
        W[b]/=W[b].sum()
    return W
def resample16(x,sr):
    # matches Resampler in src/engine/mel.ts: box filter then linear interpolation
    if sr==16000: return x
    ratio=sr/16000; taps=max(1,round(ratio))
    c=np.cumsum(np.r_[np.zeros(taps),x.astype(np.float64)])
    y=(c[taps:]-c[:-taps])/taps
    pos=np.arange(int(np.floor((len(x)-1)/ratio))+1)*ratio
    return np.interp(pos,np.arange(len(x)),y).astype(np.float32)
def logmel(x,sr):
    x=resample16(x,sr); sr=16000
    win,hop,nfft=params(sr)
    n=(len(x)-win)//hop+1
    if n<=0: return np.zeros((0,NB),np.float32)
    w=0.5-0.5*np.cos(2*np.pi*np.arange(win)/(win-1))
    out=np.empty((n,NB),np.float32); W=fbank(sr); norm=(w**2).sum()
    for s in range(0,n,4096):
        k=np.arange(s,min(n,s+4096))
        idx=k[:,None]*hop+np.arange(win)[None,:]
        P=np.abs(np.fft.rfft(x[idx]*w,nfft,axis=1))**2/norm
        out[k]=np.log(P@W.T+1e-8)
    return out
def normalize(m):
    # stats from the louder 70% of frames, so long silences don't skew them
    e=m.mean(1); sel=m[e>=np.percentile(e,30)] if len(m)>20 else m
    return (m-sel.mean(0))/(sel.std(0)+1e-3)
