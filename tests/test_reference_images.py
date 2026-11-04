"""Check sparse reference collection without ComfyUI startup or paid requests."""

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import torch
from torch.nn import functional


def load_reference_nodes():
    loader = type(
        "LoadImage",
        (),
        {
            "INPUT_TYPES": classmethod(
                lambda cls: {
                    "required": {"image": (["existing.png"], {"image_upload": True})}
                }
            ),
            "load_image": Mock(
                return_value=(torch.ones((1, 8, 8, 3)), torch.zeros((1, 8, 8)))
            ),
            "VALIDATE_INPUTS": classmethod(lambda cls, image: image == "existing.png"),
            "IS_CHANGED": classmethod(lambda cls, image: "file-hash"),
        },
    )
    core = types.ModuleType("nodes")
    core.LoadImage = loader
    utils = types.ModuleType("comfy.utils")
    utils.common_upscale = lambda image, width, height, *_: functional.interpolate(
        image, size=(height, width), mode="bilinear", align_corners=False
    )
    spec = importlib.util.spec_from_file_location(
        "reference_images_under_test",
        Path(__file__).resolve().parents[1] / "reference_images.py",
    )
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"nodes": core, "comfy.utils": utils}):
        spec.loader.exec_module(module)
    return module, loader


class ReferenceImageTests(unittest.TestCase):
    def setUp(self):
        self.module, self.loader = load_reference_nodes()

    def test_empty_upload_is_valid_and_does_not_open_a_file(self):
        upload = self.module.BenpayReferenceImage
        self.assertIs(upload.VALIDATE_INPUTS(""), True)
        self.assertEqual(upload.IS_CHANGED(""), "empty")
        images, _ = upload().load_image("")
        self.assertEqual(images.shape[0], 0)
        self.loader.load_image.assert_not_called()
        self.assertEqual(
            upload.INPUT_TYPES()["required"]["image"][0], ["", "existing.png"]
        )

    def test_nonempty_upload_uses_existing_file_validation_and_loading(self):
        upload = self.module.BenpayReferenceImage
        self.assertIs(upload.VALIDATE_INPUTS("existing.png"), True)
        self.assertIs(upload.VALIDATE_INPUTS("missing.png"), False)
        self.assertEqual(upload.IS_CHANGED("existing.png"), "file-hash")
        self.assertEqual(upload().load_image("existing.png")[0].shape[0], 1)
        self.loader.load_image.assert_called_once_with("existing.png")

    def test_three_uploaded_images_with_gaps_collect_only_three_in_order(self):
        empty = torch.empty((0, 1, 1, 3))
        result = self.module.BenpayReferenceImages().collect(
            image1=torch.full((1, 8, 8, 3), 0.1),
            image2=empty,
            image3=torch.full((1, 8, 8, 3), 0.3),
            image4=empty,
            image5=torch.full((1, 8, 8, 3), 0.5),
        )[0]
        self.assertEqual(result.shape, (3, 8, 8, 3))
        torch.testing.assert_close(result[:, 0, 0, 0], torch.tensor([0.1, 0.3, 0.5]))

    def test_all_empty_fails_before_video_request(self):
        with self.assertRaisesRegex(ValueError, "at least one reference image"):
            self.module.BenpayReferenceImages().collect(
                image1=torch.empty((0, 1, 1, 3))
            )

    def test_different_dimensions_and_alpha_form_a_valid_batch(self):
        result = self.module.BenpayReferenceImages().collect(
            image2=torch.ones((1, 8, 12, 3)), image4=torch.ones((1, 16, 10, 4))
        )[0]
        self.assertEqual(result.shape, (2, 8, 12, 4))

    def test_single_uploaded_image_is_accepted(self):
        result = self.module.BenpayReferenceImages().collect(
            image4=torch.ones((1, 8, 8, 3))
        )[0]
        self.assertEqual(result.shape[0], 1)
