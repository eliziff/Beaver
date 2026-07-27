"use client";

import React from "react";

export function MikeIcon({
    spin = false,
    done = false,
    error = false,
    mike = false,
    size = 24,
    style,
}: {
    spin?: boolean;
    done?: boolean;
    error?: boolean;
    mike?: boolean;
    size?: number;
    style?: React.CSSProperties;
}) {
    void mike;
    const color = error ? "#991b1b" : done ? "#166534" : "#d52b1e";

    return (
        <span
            aria-hidden="true"
            className={`maple-leaf-mark${spin ? " maple-leaf-mark--active" : ""}`}
            style={{ color, ...style }}
        >
            <svg
                viewBox="0 0 64 64"
                width={size}
                height={size}
                fill="currentColor"
                focusable="false"
            >
                <path d="M32 3 27.7 13.7 21.5 9.6 23.7 21.3 13.5 16.3 16.7 28 6.6 30.1 17.4 38.8 13.1 45.2 28.6 42.4 27.5 58 32 55.3 36.5 58 35.4 42.4 50.9 45.2 46.6 38.8 57.4 30.1 47.3 28 50.5 16.3 40.3 21.3 42.5 9.6 36.3 13.7Z" />
            </svg>
        </span>
    );
}
