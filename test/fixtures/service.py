"""Service module."""
from __future__ import annotations
import os, sys as system
import app.models.user
from app.models import order, invoice as inv
from . import utils
from .helpers import (
    slugify,
    normalize,  # trailing comment
)
from ..core.base import Base
from typing import TYPE_CHECKING
# import not_real
s = "import fake"

if TYPE_CHECKING:
    from app.schemas.user import UserSchema

def f():
    import json
    return json.dumps({})
