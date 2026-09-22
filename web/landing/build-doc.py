#!/usr/bin/env python3
"""build-doc.py — render a repo markdown doc into the Pages landing site.

The landing (`web/landing/`) is published verbatim to GitHub Pages by
`.github/workflows/pages.yml`; there is no site generator in the path. So a doc
that should be readable at a URL is rendered here, once, into a standalone HTML
file that carries the same theme as `index.html` (inline CSS, no build step, no
external assets beyond the Geist webfont the landing already loads).

    python3 web/landing/build-doc.py \
        docs/ava-capstone-convergence.md \
        web/landing/voice-convergence.html

The output is committed, not generated at deploy time — a Pages publish must not
depend on the runner having this script's dependencies. Re-run it when the
markdown changes; `--check` fails if the committed HTML is stale, which is what
CI can assert.
"""
from __future__ import annotations

import argparse
import html
import re
import sys
from pathlib import Path

try:
    import markdown
except ImportError:  # pragma: no cover - operator-facing message
    raise SystemExit("build-doc.py: needs python-markdown (pip install markdown)")

# Mirrors index.html's :root — one theme, two pages.
THEME = """
    :root {
      color-scheme: dark;
      --p-bg: #0b0d10;
      --p-bg-elevated: #12151a;
      --p-surface: #181c22;
      --p-surface-hover: #1f242c;
      --p-border: #262c35;
      --p-text: #f4f7fb;
      --p-text-secondary: #cdd6e0;
      --p-text-muted: #a8b2bf;
      --p-accent: #fbbf24;
      --p-accent-hover: #fcd34d;
      --p-accent-tint: rgba(251, 191, 36, 0.12);
      --p-success: #3ddc84;
      --p-warning: #f5b544;
      --p-danger: #f25f5f;
      --p-info: #5ac8fa;
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 16px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0 auto;
      max-width: 62rem;
      padding: 2.5rem 1.5rem 6rem;
      background: var(--p-bg);
      color: var(--p-text);
      font-family: "Geist", ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      font-size: 1.02rem;
      line-height: 1.7;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--p-accent); text-decoration: none; }
    a:hover { color: var(--p-accent-hover); text-decoration: underline; }
    .docnav {
      display: flex; gap: 1.25rem; align-items: baseline; flex-wrap: wrap;
      padding-bottom: 1.5rem; margin-bottom: 2rem;
      border-bottom: 1px solid var(--p-border); font-size: .94rem;
    }
    .docnav .brand { font-weight: 700; letter-spacing: -.01em; color: var(--p-text); }
    .docnav .sep { color: var(--p-text-muted); }
    h1, h2, h3, h4 { line-height: 1.25; letter-spacing: -.015em; }
    h1 { font-size: 2rem; margin: 0 0 1rem; }
    h2 {
      font-size: 1.4rem; margin: 3rem 0 1rem; padding-top: 1.4rem;
      border-top: 1px solid var(--p-border);
    }
    h3 { font-size: 1.12rem; margin: 2rem 0 .75rem; }
    h4 { font-size: 1rem; margin: 1.5rem 0 .5rem; color: var(--p-text-secondary); }
    code {
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: .885em; background: var(--p-surface);
      padding: .12em .38em; border-radius: var(--radius-sm);
      border: 1px solid var(--p-border);
    }
    pre {
      background: var(--p-bg-elevated); border: 1px solid var(--p-border);
      border-radius: var(--radius-md); padding: 1rem 1.1rem; overflow-x: auto;
    }
    pre code { background: none; border: 0; padding: 0; font-size: .86rem; }
    table {
      width: 100%; border-collapse: collapse; margin: 1.25rem 0;
      font-size: .94rem; display: block; overflow-x: auto;
    }
    th, td {
      border: 1px solid var(--p-border); padding: .55rem .7rem;
      text-align: left; vertical-align: top;
    }
    th { background: var(--p-surface); font-weight: 600; }
    tr:nth-child(even) td { background: var(--p-bg-elevated); }
    blockquote {
      margin: 1.25rem 0; padding: .35rem 0 .35rem 1rem;
      border-left: 3px solid var(--p-accent);
      background: var(--p-accent-tint); border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    }
    blockquote > p { margin: .5rem 0; }
    hr { border: 0; border-top: 1px solid var(--p-border); margin: 2.5rem 0; }
    ul, ol { padding-left: 1.4rem; }
    li { margin: .3rem 0; }
    .toc {
      background: var(--p-surface); border: 1px solid var(--p-border);
      border-radius: var(--radius-md); padding: 1rem 1.25rem; margin: 0 0 2.5rem;
      font-size: .93rem;
    }
    .toc::before {
      content: "On this page"; display: block; font-weight: 600;
      color: var(--p-text-muted); margin-bottom: .5rem;
      text-transform: uppercase; letter-spacing: .08em; font-size: .75rem;
    }
    .toc ul { margin: 0; padding-left: 1.1rem; }
    .toc > ul { padding-left: 0; list-style: none; }
    .provenance {
      margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid var(--p-border);
      color: var(--p-text-muted); font-size: .88rem;
    }
    @media (max-width: 640px) {
      body { padding: 1.5rem 1rem 4rem; font-size: .98rem; }
      h1 { font-size: 1.55rem; }
      h2 { font-size: 1.2rem; }
    }
"""

TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@450;500;600;700&display=swap" rel="stylesheet">
  <title>{title} — Zeus</title>
  <meta name="description" content="{description}">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23fbbf24'/%3E%3Cpath fill='%230b0d10' d='M37.6 8 13.5 37.4h13.1l-1.8 18.6L50.5 25.8H36.9z'/%3E%3C/svg%3E">
  <style>{theme}  </style>
</head>
<body>
  <div class="docnav">
    <a class="brand" href="./">Zeus</a>
    <span class="sep">·</span>
    <a href="https://github.com/innotelinc/zeus/blob/master/{source}">Edit this doc</a>
    <span class="sep">·</span>
    <a href="https://github.com/innotelinc/zeus/tree/master/docs">All docs</a>
  </div>
{toc}
{body}
  <p class="provenance">
    Rendered from <a href="https://github.com/innotelinc/zeus/blob/master/{source}">{source}</a>
    by <code>web/landing/build-doc.py</code>.
    The markdown is the source of truth; edits to this page are overwritten.
  </p>
</body>
</html>
"""

# Not a full YAML parser: enough to lift the title out of a doc's front matter
# or its first H1, and a one-line description from the opening paragraph.
H1_RE = re.compile(r"^#\s+(.*)$", re.MULTILINE)


def first_heading(text: str) -> str:
    m = H1_RE.search(text)
    return m.group(1).strip() if m else "Documentation"


def description(text: str, title: str) -> str:
    """First substantial paragraph after the H1, stripped of markdown noise."""
    body = text[H1_RE.search(text).end():] if H1_RE.search(text) else text
    for block in re.split(r"\n\s*\n", body):
        line = " ".join(block.split())
        if not line or line.startswith(("|", "#", ">", "-", "*", "```", "---")):
            continue
        line = re.sub(r"[*`_\[\]]|\(https?://\S+\)", "", line)
        return (line[:197] + "…") if len(line) > 200 else line
    return title


def render(md_path: Path) -> str:
    text = md_path.read_text(encoding="utf-8")
    md = markdown.Markdown(
        extensions=["tables", "fenced_code", "toc", "sane_lists", "attr_list"],
        extension_configs={"toc": {"toc_depth": "2-3", "permalink": False}},
    )
    body = md.convert(text)
    toc = getattr(md, "toc", "").strip()
    title = html.escape(first_heading(text))
    source = md_path.as_posix()

    # The doc's own H1 becomes the page H1; the TOC box sits under it. Markdown's
    # toc output is a bare <ul>, so it is put in a figure-like wrapper.
    toc_html = f'  <div class="toc">\n{toc}\n  </div>\n' if toc else ""
    body_html = "\n".join("  " + line if line.strip() else line for line in body.splitlines())

    return TEMPLATE.format(
        title=title,
        description=html.escape(description(text, title), quote=True),
        theme=THEME,
        toc=toc_html,
        body=body_html,
        source=source,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("markdown_file", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--check", action="store_true",
                        help="exit 1 if the output is missing or stale (no write)")
    args = parser.parse_args(argv)

    if not args.markdown_file.is_file():
        print(f"build-doc.py: no such markdown file: {args.markdown_file}", file=sys.stderr)
        return 2

    rendered = render(args.markdown_file)

    if args.check:
        if not args.output.is_file():
            print(f"build-doc.py: {args.output} is missing", file=sys.stderr)
            return 1
        if args.output.read_text(encoding="utf-8") != rendered:
            print(f"build-doc.py: {args.output} is stale", file=sys.stderr)
            return 1
        print(f"build-doc.py: {args.output} is current")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")
    print(f"build-doc.py: wrote {args.output} ({len(rendered)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
