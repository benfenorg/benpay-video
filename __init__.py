"""ComfyUI video generation nodes for BenPay protocols."""

from server import PromptServer

from .configuration_routes import register_configuration_routes
from .nodes import BenpayVideo, BenpayVideoFromImages
from .reference_images import BenpayReferenceImage, BenpayReferenceImages

WEB_DIRECTORY = "./web"


register_configuration_routes(PromptServer.instance.routes)


NODE_CLASS_MAPPINGS = {
    "BenpayVideo": BenpayVideo,
    "BenpayVideoFromImages": BenpayVideoFromImages,
    "BenpayReferenceImage": BenpayReferenceImage,
    "BenpayReferenceImages": BenpayReferenceImages,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BenpayVideo": "BenPay Text to Video",
    "BenpayVideoFromImages": "BenPay Image to Video",
    "BenpayReferenceImage": "Load Reference Image (optional)",
    "BenpayReferenceImages": "Batch Reference Images",
}
