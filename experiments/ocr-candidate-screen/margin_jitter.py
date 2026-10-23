"""Perturb only blank margins, preserving every nonwhite source pixel."""

import cv2
import numpy as np


def jitter_margins(image, offsets):
    yy, xx = np.where(image < 255)
    if not len(xx):
        return image
    x0, x1, y0, y1 = int(xx.min()), int(xx.max()) + 1, int(yy.min()), int(yy.max()) + 1
    margins = [y0, image.shape[0] - y1, x0, image.shape[1] - x1]
    top, bottom, left, right = [max(0, round(size * (1 + offset))) for size, offset in zip(margins, offsets)]
    return cv2.copyMakeBorder(image[y0:y1, x0:x1], top, bottom, left, right, cv2.BORDER_CONSTANT, value=255)
