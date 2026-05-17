---
name: refactor-react
description: "Refactor React class components to function components with hooks, preserving prop types, lifecycle behaviour, and side effects."
version: "0.1.0"
author: "Horizon Team"
tags: [react, refactor, hooks, javascript, typescript]
aliases: [react-hooks, class-to-hooks, react-refactor]
triggers: [refactor react class component, convert to hooks, clean up react component]
examples: [convert this class component to hooks, refactor this React component safely]
permissions: ["filesystem.read"]
helpers: ["helpers/find-class-components.js"]
---
# Refactoring React class components to hooks

When the user asks to "refactor" or "clean up" a React class component, or
when you see a `class X extends React.Component`, follow this procedure.

## 1. Audit the class before touching code

Run the bundled helper to list every class component in the workspace so you
do not miss any:

```
skill_run_helper { skill: "refactor-react", helper: "helpers/find-class-components.js", args: { root: "<workspace root>" } }
```

The helper returns `{ files: [{ path, className, line }] }`. Pick the file
the user mentioned (or ask which one if ambiguous).

## 2. Map lifecycle methods → hooks

| Class method                  | Replacement                                                    |
| ----------------------------- | -------------------------------------------------------------- |
| `constructor` (state init)    | `useState` per field, one call each                            |
| `componentDidMount`           | `useEffect(() => { ... }, [])`                                 |
| `componentDidUpdate`          | `useEffect(() => { ... }, [deps])` — list the actual deps      |
| `componentWillUnmount`        | cleanup function returned from a `useEffect`                   |
| `shouldComponentUpdate`       | `React.memo` + dependency arrays; avoid manual diffing         |
| `getSnapshotBeforeUpdate`     | rare — keep as ref + layout effect if truly needed             |
| `static getDerivedStateFromProps` | derive in render with `useMemo`, or lift state up         |

## 3. Convert step-by-step

1. Replace the `class` declaration with a function component.
2. Replace `this.state` reads with the destructured `useState` getters.
3. Replace `this.setState({ x })` with `setX(...)`. Batch related fields into one state object only when they always change together.
4. Replace `this.props.X` with the destructured prop `X`.
5. Replace each lifecycle method per the table above.
6. Replace event-handler bindings (`this.handle = this.handle.bind(this)`) with inline `const handle = useCallback(...)` only when the handler is passed to memoised children — otherwise plain `function` declarations are fine.
7. Replace `this.refs.X` with `useRef(null)` + JSX `ref={ref}`.

## 4. Preserve types

- If the file is TypeScript, keep the existing `Props` / `State` types — `State` becomes individual `useState<T>` type parameters.
- Default props move from `static defaultProps` to function-arg destructuring defaults.

## 5. Final checks

- Linter / typechecker passes.
- The component tree renders identically (no missing `useEffect` deps that would change re-render frequency).
- Tell the user what side effects you changed (e.g. "moved fetchUser into useEffect with [userId] as dep — was previously triggered by both mount and componentDidUpdate").

Do not refactor unrelated code in the same pass. Keep PRs reviewable.
