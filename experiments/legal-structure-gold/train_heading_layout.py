"""Fine-tune pretrained Heron for heading detection, without heading levels or parents.

prepare --inputs FROZEN_INPUTS --out PRIVATE_MODEL_DIR [--work AUTHORING_WORK]
train --out PRIVATE_MODEL_DIR [--work AUTHORING_WORK]

Preparation projects the gold store's current headings (experiments/legal_pdf_corpus/gold_store.py)
onto their authoring geometry and writes standard COCO boxes. Images stay where author.py rendered
them (its --work folder). Pages with unlocatable headings are excluded, not treated as negative
examples. Only sources whose partition (source.json) is train are read.

Training follows Transformers' object-detection recipe and retains Heron's pretrained
section-header classifier channel. This experimental one-class detector is not a full
layout-provider replacement. No evaluation or test suite runs as part of either command.
"""
import argparse
import copy
import gzip
import hashlib
import json
import struct
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "legal_pdf_corpus"))
import gold_store  # noqa: E402

MODEL = "docling-project/docling-layout-heron"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def heading_box(typed, lines):
    boxes = []
    for span in typed["spans"]:
        line = lines[span["line_id"]]
        if span["start"] == 0 and span["end"] >= len(line["text"].rstrip()):
            boxes.append(line["bbox"])
        else:
            boxes.extend(word["bbox"] for word in line.get("words", [])
                         if word["start"] < span["end"] and span["start"] < word["end"])
    if not boxes:
        return None
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def prepare(args):
    images, annotations, sources, excluded = [], [], [], []
    for sha, reference in gold_store.sources(gold_store.STRUCTURE):
        if gold_store.source(sha).get("partition") != "train":
            continue
        receipt = json.loads(reference.with_name("receipt.json").read_text())
        if receipt["status"] != "complete":
            continue
        geometry = args.inputs / f"{sha}.json.gz"
        with gzip.open(reference, "rt", encoding="utf-8") as stream:
            gold = json.load(stream)
        with gzip.open(geometry, "rt", encoding="utf-8") as stream:
            extracted = json.load(stream)
        if gold["source_sha256"] != sha or len(extracted["pages"]) != gold["page_count"]:
            raise ValueError(f"Gold and geometry disagree for {sha}")
        lines = {line["id"]: line for page in extracted["pages"] for line in page["lines"]}
        # Source IDs locate annotations in their authoring frame, not candidate OCR predictions.
        if {line["id"] for line in gold["lines"]} != lines.keys():
            raise ValueError(f"Geometry does not hold the authoring lines for {sha}")
        boxes_by_page, incomplete = defaultdict(list), set()
        for unit in gold["units"]:
            fragments = defaultdict(list)
            for index in unit["lines"]:
                typed = gold["typed"][index]
                if typed["region"] != "heading":
                    continue
                box = heading_box(typed, lines)
                if box is None:
                    incomplete.add(typed["page"])
                else:
                    fragments[typed["page"]].append(box)
            for page, boxes in fragments.items():
                boxes_by_page[page].append([min(b[0] for b in boxes), min(b[1] for b in boxes),
                                            max(b[2] for b in boxes), max(b[3] for b in boxes)])
        retained = 0
        for page in extracted["pages"]:
            number = page["number"]
            if number in incomplete:
                excluded.append({"source_sha256": sha, "page": number,
                                 "reason": "a gold heading has no source geometry"})
                continue
            found = list((args.work / sha / "images").glob(f"page-{number:06}-*.png"))
            if len(found) != 1:
                raise ValueError(f"Expected one authoring image for {sha}, page {number}: {len(found)}")
            image = found[0]
            with image.open("rb") as source:
                header = source.read(24)
            if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
                raise ValueError(f"Expected a PNG image: {image}")
            width, height = struct.unpack(">II", header[16:24])
            image_id = len(images)
            images.append({"id": image_id, "file_name": image.relative_to(args.work).as_posix(),
                           "width": width, "height": height, "source_sha256": sha,
                           "page": number, "mode": receipt["mode"]})
            for box in boxes_by_page[number]:
                x0, y0, x1, y1 = [max(0.0, min(value / extent, 1.0)) * pixels
                                  for value, extent, pixels in zip(box,
                                      [page["width"], page["height"], page["width"], page["height"]],
                                      [width, height, width, height])]
                if x1 <= x0 or y1 <= y0:
                    raise ValueError(f"Empty heading box for {sha}, page {number}")
                annotations.append({"id": len(annotations), "image_id": image_id,
                                    "category_id": 0, "bbox": [x0, y0, x1 - x0, y1 - y0],
                                    "area": (x1 - x0) * (y1 - y0), "iscrowd": 0})
            retained += 1
        sources.append({"source_sha256": sha, "gold_sha256": digest(reference),
                        "geometry_sha256": digest(geometry), "pages": retained})
        if len(sources) % 50 == 0:
            print(f"Prepared {len(sources)} documents / {len(images)} pages", flush=True)
    args.out.mkdir(parents=True, exist_ok=True)
    data = {"images": images, "annotations": annotations,
            "categories": [{"id": 0, "name": "heading"}]}
    (args.out / "train.coco.json").write_text(json.dumps(data) + "\n", encoding="utf-8")
    provenance = {"submission_origin": "machine_test", "run_id": "legal-heading-layout",
                  "split": "train", "eligible_documents": len(sources),
                  "documents": sum(bool(source["pages"]) for source in sources), "pages": len(images),
                  "headings": len(annotations), "excluded_pages": excluded, "sources": sources,
                  "dataset_sha256": digest(args.out / "train.coco.json")}
    (args.out / "dataset-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(json.dumps({key: provenance[key] for key in ("documents", "pages", "headings")}), flush=True)


class Pages:
    def __init__(self, root, data, processor):
        self.root, self.images, self.processor = root, data["images"], processor
        self.annotations = defaultdict(list)
        for annotation in data["annotations"]:
            self.annotations[annotation["image_id"]].append(annotation)

    def __len__(self):
        return len(self.images)

    def __getitem__(self, index):
        from PIL import Image
        page = self.images[index]
        with Image.open(self.root / page["file_name"]) as image:
            inputs = self.processor(images=image.convert("RGB"), annotations={
                "image_id": page["id"], "annotations": self.annotations[page["id"]]}, return_tensors="pt")
        return {"pixel_values": inputs["pixel_values"][0], "labels": inputs["labels"][0]}


def collate(batch):
    import torch
    return {"pixel_values": torch.stack([row["pixel_values"] for row in batch]),
            "labels": [row["labels"] for row in batch]}


def train(args):
    import torch
    from huggingface_hub import HfApi
    from transformers import AutoImageProcessor, AutoModelForObjectDetection, Trainer, TrainingArguments
    from transformers.trainer_utils import get_last_checkpoint, set_seed

    if not torch.cuda.is_available():
        raise RuntimeError("This training run requires the desktop GPU")
    set_seed(7)
    provenance = json.loads((args.out / "dataset-provenance.json").read_text())
    dataset = args.out / "train.coco.json"
    if digest(dataset) != provenance["dataset_sha256"] or provenance["split"] != "train":
        raise ValueError("Prepared training data changed")
    revision = HfApi(token=False).model_info(MODEL).sha
    processor = AutoImageProcessor.from_pretrained(MODEL, revision=revision, token=False)
    original = AutoModelForObjectDetection.from_pretrained(MODEL, revision=revision, token=False)
    heading = next(index for index, label in original.config.id2label.items() if label == "section_header")
    old_labels = original.config.num_labels
    config = copy.deepcopy(original.config)
    config.num_labels = 1
    config.id2label, config.label2id = {0: "heading"}, {"heading": 0}
    model = AutoModelForObjectDetection.from_config(config)
    weights = original.state_dict()
    adapted = []
    for name, target in model.state_dict().items():
        source = weights[name]
        if source.shape == target.shape:
            continue
        if "denoising_class_embed" in name and source.shape[0] == old_labels + 1:
            weights[name] = source[[heading, old_labels]]
        elif ("class_embed" in name or "enc_score_head" in name) and source.shape[0] == old_labels:
            weights[name] = source[heading:heading + 1]
        else:
            raise ValueError(f"Unexpected pretrained tensor mismatch: {name}: {source.shape} -> {target.shape}")
        adapted.append(name)
    model.load_state_dict(weights, strict=True)
    del original, weights
    (args.out / "initialization.json").write_text(json.dumps({
        "model": MODEL, "revision": revision, "source_label": "section_header",
        "adapted_classifier_tensors": adapted, "randomly_initialized_tensors": [],
        "script_sha256": digest(Path(__file__)), "training_dataset_sha256": digest(dataset),
    }, indent=2) + "\n")
    print(f"Fine-tuning {MODEL}@{revision}; {provenance['documents']} documents, "
          f"{provenance['pages']} pages; {sum(p.numel() for p in model.parameters()):,} parameters", flush=True)
    arguments = TrainingArguments(
        output_dir=str(args.out / "checkpoints"), num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch, gradient_accumulation_steps=4,
        learning_rate=5e-5, lr_scheduler_type="cosine", warmup_steps=0.05,
        weight_decay=1e-4, max_grad_norm=0.1, bf16=True,
        dataloader_num_workers=1, save_strategy="epoch", save_total_limit=1,
        eval_strategy="no", logging_steps=25, logging_first_step=True,
        logging_nan_inf_filter=False, remove_unused_columns=False,
        report_to=[], push_to_hub=False, seed=7, disable_tqdm=True,
    )
    trainer = Trainer(model=model, args=arguments, processing_class=processor,
                      train_dataset=Pages(args.work, json.loads(dataset.read_text()), processor),
                      data_collator=collate)
    checkpoint = get_last_checkpoint(arguments.output_dir) if Path(arguments.output_dir).exists() else None
    result = trainer.train(resume_from_checkpoint=checkpoint)
    trainer.save_state()
    (args.out / "training-result.json").write_text(json.dumps({
        "checkpoint": get_last_checkpoint(arguments.output_dir), "metrics": result.metrics,
        "evaluation_run": False, "test_run": False,
    }, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "train"))
    parser.add_argument("--work", type=Path, default=gold_store.WORK, help="author.py's working folder, holding its page images")
    parser.add_argument("--inputs", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch", type=int, default=2)
    args = parser.parse_args()
    if args.command == "prepare":
        if args.inputs is None:
            parser.error("prepare requires --inputs")
        prepare(args)
    else:
        train(args)


if __name__ == "__main__":
    main()
