# Filler model training

Python reference for the in-browser filler detector.

- `mel.py`: feature reference; `src/engine/mel.ts` must match it exactly.
- `amihf.py`: builds training data from the AMI Meeting Corpus (CC BY 4.0) using the
  `edinburghcstr/ami` IHM recordings on Hugging Face and the AMI manual word annotations.
- `data.py`: AMI Mix-Headset data and the evaluation set.
- `train.py`: trains the dilated CNN (`python train.py 32 2500`).
- `export.py`: writes `src/engine/fillerModel.ts`.

Evaluation used PodcastFillers clips, whose labels are licensed for non-commercial research only.
They are used to measure accuracy, never for training.
