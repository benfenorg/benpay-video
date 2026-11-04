"""Optional reference uploads and collection without empty-image failures."""

import torch
from comfy.utils import common_upscale
from torch.nn import functional

from nodes import LoadImage


class BenpayReferenceImage(LoadImage):
    CATEGORY = "video/BenPay"

    @classmethod
    def INPUT_TYPES(cls) -> dict:
        inputs = super().INPUT_TYPES()
        choices, options = inputs["required"]["image"]
        inputs["required"]["image"] = (["", *choices], options)
        return inputs

    def load_image(self, image: str) -> tuple:
        if not image:
            return torch.empty((0, 1, 1, 3)), torch.empty((0, 1, 1))
        images, masks = super().load_image(image)
        if images.shape[0] != 1:
            raise ValueError("Each reference upload must contain one still image.")
        return images, masks

    @classmethod
    def VALIDATE_INPUTS(cls, image: str) -> bool | str:
        return True if not image else super().VALIDATE_INPUTS(image)

    @classmethod
    def IS_CHANGED(cls, image: str) -> str:
        return "empty" if not image else super().IS_CHANGED(image)


class BenpayReferenceImages:
    CATEGORY = "video/BenPay"
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "collect"

    @classmethod
    def INPUT_TYPES(cls) -> dict:
        return {"optional": {f"image{index}": ("IMAGE",) for index in range(1, 6)}}

    def collect(self, **inputs: torch.Tensor) -> tuple:
        images = [
            inputs[name]
            for name in (f"image{index}" for index in range(1, 6))
            if name in inputs and inputs[name] is not None and inputs[name].shape[0] > 0
        ]
        if not images:
            raise ValueError("Upload at least one reference image before running.")
        first = images[0]
        channels = max(image.shape[-1] for image in images)
        normalized = []
        for image in images:
            image = image.to(device=first.device, dtype=first.dtype)
            if image.shape[-1] != channels:
                image = functional.pad(
                    image, (0, channels - image.shape[-1]), value=1.0
                )
            if image.shape[1:3] != first.shape[1:3]:
                image = common_upscale(
                    image.movedim(-1, 1),
                    first.shape[2],
                    first.shape[1],
                    "bilinear",
                    "center",
                ).movedim(1, -1)
            normalized.append(image)
        return (torch.cat(normalized, dim=0),)
