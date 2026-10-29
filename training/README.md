# Filler model training

Python reference for the in-browser filler detector.

- `mel.py`: feature reference; `src/engine/mel.ts` must match it exactly.
- `amihf.py`: builds training data from the AMI Meeting Corpus (CC BY 4.0) using the
  `edinburghcstr/ami` IHM recordings on Hugging Face and the AMI manual word annotations.
- `data.py`: AMI Mix-Headset data and the evaluation set.
- `train.py`: trains the dilated CNN (`python train.py 32 2500`).
- `export.py`: writes `src/engine/fillerModel.ts` (`python export.py net32.pt [turkish]`).

Evaluation used PodcastFillers clips, whose labels are licensed for non-commercial research only.
They are used to measure accuracy, never for training.

## Turkish fine-tune

`finetune.py` continues training the AMI model on a recording whose filler cuts were corrected
by hand in Pauseless (the first 40 minutes of one Turkish podcast, 150 fillers). Half of each batch
comes from that recording, half from AMI, so English accuracy holds. On the last 8 minutes of the
corrected part, which training never saw: F1 0.63 before, 0.75 after. The recording itself is not
in this repository.
