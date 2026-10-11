import type { Skill } from '../../shared/types';

type BuiltinSkill = Omit<Skill, 'builtin' | 'updatedAt'>;

/**
 * Built-in slash commands. `{{args}}` is replaced by whatever the user types after the command.
 * Users can override any of these from the Skills page.
 */
export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: 'landing',
    title: 'Build a landing page',
    icon: '🚀',
    argsHint: 'Product or topic description',
    description: 'Build a complete, polished, responsive landing page from scratch',
    body: `Build a polished, complete landing page for "{{args}}".

Requirements:
1. Take a quick look at the project structure and tech stack first. With no framework, use plain HTML/CSS/JS; with a framework, follow the existing conventions.
2. Include: a nav bar, a hero (headline + subheading + primary and secondary CTAs), selling points/features, social proof (testimonials or a logo wall), pricing, an FAQ, and a footer. Write specific copy, no lorem ipsum.
3. Visuals: modern, restrained, with a clear hierarchy; a consistent system for color, type sizes and spacing; tasteful motion (hover, fade-in on scroll) that respects prefers-reduced-motion.
4. Responsive: it should look good on phone, tablet and desktop. Accessibility: semantic tags, enough contrast, image alt text, keyboard support.
5. When done, check both desktop and mobile with preview_screenshot, fix any problems you find, then give a short report.`,
  },
  {
    name: 'component',
    title: 'Create a component',
    icon: '🧩',
    argsHint: 'Component description, e.g. a dropdown select with search',
    description: "Build a reusable component in the project's existing style",
    body: `Build this component: {{args}}

Requirements:
- Follow the project's existing framework, folder structure, naming and styling approach.
- Make it reusable: sensible props/parameters, defaults, controlled/uncontrolled modes (where it applies).
- Cover interaction states: hover, focus (with a visible focus style), disabled, loading, empty and error states.
- Accessibility: correct semantics and ARIA, keyboard support.
- Put a usage example on an existing page (or a new demo page) and confirm it looks right with preview_screenshot.`,
  },
  {
    name: 'responsive',
    title: 'Responsive check',
    icon: '📱',
    argsHint: 'Page path (optional, defaults to the current page)',
    description: 'Screenshot the page at phone, tablet and desktop sizes and fix layout problems',
    body: `Do a responsive check of page {{args}} and fix the problems (if no path is given, check the current preview page and the home page).

Steps:
1. Take screenshots with preview_screenshot on mobile, tablet and desktop (use fullPage when needed).
2. Find problems: horizontal scrolling/overflow, text too small or cramped, tap targets too small, distorted images, overlapping elements, navigation unusable on phones, unbalanced spacing, and so on.
3. Fix them one by one (prefer fluid layouts, clamp() and sensible breakpoints), then screenshot again to confirm.
4. Report: what you found at each size and what you changed.`,
  },
  {
    name: 'fix-console',
    title: 'Fix console errors',
    icon: '🩺',
    argsHint: 'Page path (optional)',
    description: 'Open the page, collect console errors and failed requests, and fix them one by one',
    body: `Check and fix console problems on the preview page. Page: {{args}} (if not given, check the current page and the home page).

1. Open the page with preview_console and collect errors, warnings and failed network requests.
2. Sort them by impact, find the root cause and fix it (don't "fix" things by swallowing errors in try/catch).
3. Run preview_console again to confirm the problems are gone and nothing new was introduced.
4. Report which problems you fixed and what caused each one.`,
  },
  {
    name: 'polish',
    title: 'UI polish',
    icon: '💅',
    argsHint: 'Page or area to polish (optional)',
    description: 'Refine spacing, type, alignment, color and micro-interactions for a higher-quality feel',
    body: `Do a round of UI polish on {{args}} (if not given, the current preview page).

Look closely with preview_screenshot first, then improve:
- Spacing rhythm: a consistent spacing scale, plenty of whitespace between sections, aligned elements.
- Typography: a clear type-size hierarchy, suitable line heights and weights, and a good pairing of text and numerals.
- Color: use the primary color sparingly, meet text contrast requirements, keep borders/dividers soft.
- Details: consistent corner radii and shadows, hover/active/focus states on buttons and links, natural transitions.
- Keep existing functionality and structure unchanged.
After the changes, take screenshots again to compare and list the main changes.`,
  },
  {
    name: 'dark-mode',
    title: 'Add dark mode',
    icon: '🌙',
    argsHint: '',
    description: 'Light/dark themes and a toggle button built on CSS variables',
    body: `Add dark mode to the project. {{args}}

- Organize colors into CSS variables (or the project's existing theming approach, such as Tailwind's dark: variant).
- Follow the system prefers-color-scheme by default and provide a toggle button; save the choice in localStorage, with no flash on first paint.
- Check contrast, images/icons, shadows and borders on every page in dark mode.
- Look at both themes with preview_screenshot.`,
  },
  {
    name: 'a11y',
    title: 'Accessibility review',
    icon: '♿',
    argsHint: 'Page path (optional)',
    description: 'Find and fix problems with semantics, contrast, keyboard use, ARIA and more',
    body: `Do an accessibility review of {{args}} (if not given, the current page) and fix what you find.

Check: semantic tags and heading levels, image alt text, form labels and error messages, color contrast (WCAG AA), keyboard operability and visible focus styles, correct ARIA usage, motion and prefers-reduced-motion, and the page's lang attribute.
List the problems first (by severity), then fix them one by one, and finally note anything that still needs a human to confirm.`,
  },
  {
    name: 'seo',
    title: 'SEO optimization',
    icon: '🔎',
    argsHint: 'Site topic/keywords (optional)',
    description: 'Meta tags, Open Graph, structured data, semantic structure and performance-related SEO',
    body: `Optimize the site for SEO. Extra info: {{args}}

- A title, description and canonical on every page; Open Graph and Twitter Card; a favicon.
- A sensible heading hierarchy (one h1 per page), semantic structure, image alt text, descriptive link text.
- Suitable JSON-LD structured data (Organization / WebSite / Product / FAQ, etc., as needed).
- robots.txt and sitemap.xml (can be generated directly for static sites).
- List the changes, plus any real information the user needs to provide (domain, brand name, etc.).`,
  },
  {
    name: 'perf',
    title: 'Performance tuning',
    icon: '⚡',
    argsHint: 'Key pages (optional)',
    description: 'Find and fix load-time and runtime performance bottlenecks',
    body: `Do a round of performance tuning on the project. Focus: {{args}}

Check and optimize: images (size, format, lazy loading, width/height placeholders to prevent layout shift), font loading, critical above-the-fold resources, JS bundle size and splitting, unnecessary re-renders or reflows, third-party scripts, and caching strategy.
Explain the main bottlenecks you found and the expected gains before making changes; afterwards, confirm with preview_console that there are no errors.`,
  },
  {
    name: 'clone-ui',
    title: 'Build UI from an image',
    icon: '🖼️',
    argsHint: 'Extra notes (attach a screenshot/design too)',
    description: 'Recreate a page with high fidelity from an attached screenshot or design',
    body: `Implement this UI with high fidelity from the screenshot/design I attached. {{args}}

- Study the layout, spacing, type sizes, font weights, colors, corner radii, shadows and icons closely, and match them 1:1 as far as possible.
- Build it with the project's existing tech stack, with semantic structure, and make it responsive (adapt sensibly for sizes the design doesn't show).
- After implementing, take a screenshot with preview_screenshot, compare it with the design section by section, and do at least one round of fixes for the differences.`,
  },
  {
    name: 'e2e',
    title: 'Write end-to-end tests',
    icon: '🧪',
    argsHint: 'User flow to test',
    description: 'Write and run Playwright tests for key flows',
    body: `Write end-to-end tests for this flow: {{args}}

- If the project doesn't have Playwright yet, install it and create a minimal config first (baseURL pointing at the dev server).
- Prefer role- and text-based locators (getByRole, getByText) over brittle CSS selectors.
- Cover the happy path and at least one failure path.
- Run the tests until they pass. If you find a product bug, describe it and @ the relevant teammate instead of bending the test to fit the bug.`,
  },
  {
    name: 'challenge',
    title: 'Adversarial review',
    icon: '⚖️',
    argsHint: 'Focus (optional)',
    description: 'Have Skeptic look only at the requirements and the changes and try hard to prove them wrong; works as a gate before merging',
    body: `@Skeptic Do an adversarial review of the current changes: try hard to prove they are wrong, and only accept counterexamples you can reproduce. Focus: {{args}} (if not given, test everything following your usual process).`,
  },
  {
    name: 'review',
    title: 'Review changes',
    icon: '🔍',
    argsHint: 'Scope (optional, defaults to uncommitted changes)',
    description: 'Review recent changes for bugs, security and maintainability problems',
    body: `Review the code changes. Scope: {{args}} (if not given, review the uncommitted changes in git; if it isn't a git repo, review the recently modified files).

Focus on correctness, edge cases, security (XSS, injection, leaked secrets), performance, accessibility, consistency and maintainability.
Group the findings as "Must fix / Suggested / Optional", each with file and line number, a description of the problem and a suggested fix. Don't change the code yet.`,
  },
  {
    name: 'commit',
    title: 'Tidy up and commit',
    icon: '📦',
    argsHint: 'Commit notes (optional)',
    description: 'Check the changes, write a clear commit message and git commit',
    body: `Turn the current changes into commits. Extra notes: {{args}}

1. Run git status and git diff to understand the changes. If it isn't a git repo, ask me first whether to git init.
2. Make sure no files were added by mistake (node_modules, .env, build output, large files, etc.); add to .gitignore if needed.
3. If the changes cover several unrelated things, split them into separate commits by topic.
4. Use clear commit messages (a concise subject + any needed details), then commit.
5. Don't push unless I explicitly ask.`,
  },
  {
    name: 'explain',
    title: 'Explain the project',
    icon: '📖',
    argsHint: 'The part you want to understand (optional)',
    description: 'Walk through the project structure, tech stack, data flow and how to run it',
    body: `Help me understand this project quickly. Focus: {{args}}

Cover: tech stack and dependencies, folder structure, pages/routes, key components and data flow, how to run and build it, and notable problems or tech debt. Keep it concise, use lists, and give file paths for the key parts. Don't modify any files.`,
  },
];
