/**
 * The console's design system, one import.
 *
 * Every module composes these instead of inventing a panel, a badge or a
 * button, which is what keeps six products reading as one system. A module
 * that needs something new adds it here (see docs/unified-console.md §4).
 */
export { Card, CardHeader } from "./Card";
export { Badge, Dot, type BadgeTone } from "./Badge";
export { Stat } from "./Stat";
export { EmptyState } from "./EmptyState";
export { PageHeader } from "./PageHeader";
export { Button } from "./Button";
export { Tabs, type TabItem } from "./Tabs";
export { Select, type SelectOption } from "./Select";
