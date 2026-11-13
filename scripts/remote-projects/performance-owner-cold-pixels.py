"""Offline pixel-review preparation; no DOM/capture timestamps are called paint."""
import hashlib
import json
import math
import pathlib
import statistics
import sys

from PIL import Image, ImageChops, ImageDraw, ImageStat


def distribution(values):
    values = sorted(values)
    return {"count": len(values), "p50": values[math.ceil(len(values) * .5) - 1],
            "p95": values[math.ceil(len(values) * .95) - 1], "max": values[-1]}


def analyze(directory):
    document = json.loads((directory / "runs.json").read_text())
    rows = []
    # Fixed 1280x900 compositor fixture regions; crops are reviewed, not OCR labels.
    regions = {"sidebar": (12, 235, 250, 295), "transcript": (340, 135, 660, 195)}
    sheet = Image.new("RGB", (1280, len(document["runs"]) * 145), "#555555")
    draw = ImageDraw.Draw(sheet)
    for run in document["runs"]:
        raw = run["raw"]
        if raw["status"] != "measured":
            raise ValueError("A failed run cannot disappear from timing statistics")
        artifact = directory / "artifacts" / ("cold-" + str(run["index"]))
        frames = [json.loads(line) for line in (artifact / "owner-frames.jsonl").read_text().splitlines()]
        markers = raw["windows"][0][1]["dom"]["markers"]
        row = {"index": run["index"], "launchEpochMs": raw["launchEpochMs"], "targets": {}}
        for column, (target, box) in enumerate(regions.items()):
            candidates = [f for f in frames if f["frameSwapEpochMs"] is not None
                          and f["frameSwapEpochMs"] >= markers[target]]
            if not candidates:
                raise ValueError("Missing post-marker compositor frame: " + str(artifact))
            upper = candidates[0]
            reference = Image.open(artifact / frames[0]["filename"]).convert("RGB").crop(box)
            absent = []
            for frame in frames:
                if frame["frameSwapEpochMs"] is None or frame["frameSwapEpochMs"] >= upper["frameSwapEpochMs"]:
                    continue
                crop = Image.open(artifact / frame["filename"]).convert("RGB").crop(box)
                difference = statistics.mean(ImageStat.Stat(ImageChops.difference(crop, reference)).mean)
                if difference <= .1:
                    absent.append(frame)
            if not absent:
                raise ValueError("No absent-target lower-bound frame; retain as missing, not zero")
            lower = absent[-1]
            bounds = {"absentFrame": lower["filename"], "visibleCandidateFrame": upper["filename"],
                      "absentFrameSha256": lower["sha256"], "visibleCandidateFrameSha256": upper["sha256"],
                      "lowerMs": lower["frameSwapEpochMs"] - raw["launchEpochMs"],
                      "upperMs": upper["frameSwapEpochMs"] - raw["launchEpochMs"],
                      "intervalMs": upper["frameSwapEpochMs"] - lower["frameSwapEpochMs"],
                      "pixelReview": "required", "region1280x900": box}
            row["targets"][target] = bounds
            for position, frame in enumerate([lower, upper]):
                crop = Image.open(artifact / frame["filename"]).convert("RGB").crop(box)
                x = column * 640 + position * 320
                y = run["index"] * 145
                draw.text((x + 4, y + 3), f'{run["index"]} {target} {"absent" if position == 0 else "visible?"}', fill="white")
                sheet.paste(crop, (x, y + 25))
                draw.text((x + 4, y + 95), frame["filename"], fill="white")
        rows.append(row)
    output = {"phase": document["phase"], "build": document["build"], "requested": document["requestedColdStarts"],
              "actual": len(rows), "status": "pending-independent-pixel-review", "budgetPassed": False,
              "method": "Last loading-equivalent target crop to first post-eligibility actual compositor frame, reviewed as a visibility interval. DOM only chooses a candidate upper frame; it is never a paint timestamp.",
              "limitations": ["Screencast can skip frames; intervals are not exact first presentation.",
                              "Frame swap is not physical display presentation.",
                              "Fixed local fixture, production UI/source shell, no remote/large-list/iOS claim."],
              "runs": rows, "targets": {}}
    for target in regions:
        output["targets"][target] = {bound: distribution([row["targets"][target][bound] for row in rows])
                                     for bound in ["lowerMs", "upperMs", "intervalMs"]}
    sheet.save(directory / "review-frame-bounds.jpg", quality=92)
    output["reviewSheetSha256"] = hashlib.sha256((directory / "review-frame-bounds.jpg").read_bytes()).hexdigest()
    with (directory / "owner-frame-bounds.json").open("x") as handle:
        json.dump(output, handle, indent=2)
    print(json.dumps({"phase": output["phase"], "targets": output["targets"]}, indent=2))


for argument in sys.argv[1:]:
    analyze(pathlib.Path(argument))
