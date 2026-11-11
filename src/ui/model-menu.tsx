import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Icon, Skeleton } from "./kit.tsx";
import { type ModelRow, stepIndex } from "./models.ts";

/** The mechanics one shared model menu instance needs: its popover id, the
    trigger and search-box refs, and the keyboard and dismiss handlers. */
export interface ModelMenu {
	/** The popover element's id: the trigger points at it, the body renders it. */
	popId: string;
	/** This instance's CSS anchor name: the trigger carries it, the popover aims at
	    it. A page can hold several menus (one per role row, one per dialog), and a
	    shared anchor name would anchor every popover to the last trigger instead. */
	anchor: string;
	trigger: RefObject<HTMLButtonElement | null>;
	search: RefObject<HTMLInputElement | null>;
	arrowOpen: RefObject<boolean>;
	setOpen: (open: boolean) => void;
	keys: (e: KeyboardEvent<HTMLElement>) => void;
	openFromTrigger: (e: KeyboardEvent) => void;
	close: () => void;
}

/** The shared type-to-filter model menu: a trigger button opening a searchable
    popover over the catalogue (New task's picker and the Settings Model roles rows).
    The hook owns the mechanics, the two components own the markup; the caller
    builds the rows and keeps any wrappers it needs (labels, grid cells). */
export function useModelMenu(onOpen?: () => void): ModelMenu {
	// One menu per component instance: several New task dialogs (one per project)
	// and several role rows stay mounted at once, each with its own popover id.
	const popId = useId();
	// useId's ":r:" punctuation is no valid CSS ident, so the anchor strips it.
	const anchor = `--model-menu-${popId.replace(/[^a-zA-Z0-9]/g, "")}`;
	const trigger = useRef<HTMLButtonElement | null>(null);
	const search = useRef<HTMLInputElement | null>(null);
	// Set when the trigger opened the popover with an arrow key: the toggle then lands the
	// focus on the first role row instead of the search box.
	const arrowOpen = useRef(false);
	const [open, setOpen] = useState(false);
	// The caller's open hook rides the same setOpen the popover's onToggle calls (every
	// open and close path lands here). Ref-held: the handler outlives renders.
	const onOpenRef = useRef(onOpen);
	onOpenRef.current = onOpen;
	const setOpenTracked = (v: boolean): void => {
		setOpen(v);
		if (v) onOpenRef.current?.();
	};
	// Native light-dismiss misses pointerdowns on the dialog backdrop / inert page behind the
	// popover (both sit in the top layer), so some engines never close on "click somewhere else".
	// A nested popover (the Thinking level menu) is a DOM descendant, so one `contains` covers it.
	useEffect(() => {
		if (!open) return;
		const pop = document.getElementById(popId);
		if (pop === null) return;
		const onDown = (e: PointerEvent): void => {
			if (!(e.target instanceof Element) || pop.contains(e.target)) return;
			// The invoker's click is native toggle coordination; hiding here would make it reopen.
			const invoker = e.target.closest("button");
			if (invoker !== null && invoker.getAttribute("popovertarget") === popId)
				return;
			pop.hidePopover();
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [open, popId]);
	// Arrow keys walk the option rows from wherever the focus sits inside the open
	// popover; Escape closes and hands the focus back to the trigger.
	const keys = (e: KeyboardEvent<HTMLElement>): void => {
		if (e.key === "Escape") {
			// Cancel the native light dismiss: its deferred focus fixup would override the
			// trigger focus below and drop the focus on the page behind the dialog.
			e.preventDefault();
			document.getElementById(popId)?.hidePopover();
			trigger.current?.focus();
			return;
		}
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const menu =
			e.currentTarget.closest<HTMLElement>("[popover]") ??
			document.getElementById(popId);
		const opts = [
			...(menu?.querySelectorAll<HTMLElement>(".model-option") ?? []),
		];
		const idx = stepIndex(
			opts.length,
			opts.indexOf(document.activeElement as HTMLElement),
			e.key === "ArrowDown",
		);
		if (idx < 0) return;
		e.preventDefault();
		opts[idx]?.focus();
	};
	const openFromTrigger = (e: KeyboardEvent): void => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		if (open) return;
		arrowOpen.current = true;
		document.getElementById(popId)?.showPopover();
	};
	const close = (): void => {
		document.getElementById(popId)?.hidePopover();
	};
	return {
		popId,
		anchor,
		trigger,
		search,
		arrowOpen,
		setOpen: setOpenTracked,
		keys,
		openFromTrigger,
		close,
	};
}

/** The menu's trigger: a select-look button whose popover shows the shared search
    box and row list. `label` names it to screen readers and tooltips. */
export function ModelMenuTrigger({
	menu,
	label,
	invalid,
	describedBy,
	disabled,
	children,
}: {
	menu: ModelMenu;
	label: string;
	invalid?: boolean;
	describedBy?: string;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className="model-trigger"
			popoverTarget={menu.popId}
			ref={menu.trigger}
			title={label}
			aria-label={label}
			aria-invalid={invalid}
			aria-describedby={describedBy}
			disabled={disabled}
			onKeyDown={menu.openFromTrigger}
			// csstype has no anchorName yet, hence the cast.
			style={{ anchorName: menu.anchor } as React.CSSProperties}
		>
			{children}
			<Icon name="chevron-right" size={14} />
		</button>
	);
}

/** The popover itself: a search box that filters `rows` (the caller pre-filters with
    modelMatches), the n/total note while a filter is on, and one button per row.
    `after` renders caller-specific rows behind the list (New task's Thinking menu). */
export function ModelMenuBody({
	menu,
	query,
	setQuery,
	rows,
	shown,
	total,
	onPick,
	loading = false,
	after,
}: {
	menu: ModelMenu;
	query: string;
	setQuery: (q: string) => void;
	rows: ModelRow[];
	shown: number;
	total: number;
	onPick: (selector: string) => void;
	loading?: boolean;
	after?: ReactNode;
}) {
	return (
		<div
			id={menu.popId}
			popover="auto"
			className="popover model-pop"
			// csstype has no positionAnchor yet, hence the cast.
			style={{ positionAnchor: menu.anchor } as React.CSSProperties}
			onToggle={(e) => {
				menu.setOpen(e.newState === "open");
				if (e.newState !== "open") return;
				if (menu.arrowOpen.current) {
					document
						.getElementById(menu.popId)
						?.querySelector<HTMLElement>(".model-option")
						?.focus();
				} else {
					menu.search.current?.focus();
				}
				menu.arrowOpen.current = false;
			}}
		>
			<input
				ref={menu.search}
				type="search"
				className="search"
				placeholder="Search models"
				aria-label="Search models"
				value={query}
				onKeyDown={(e) => {
					// Enter in the search box must not submit a surrounding form (steer, New task, role add).
					if (e.key === "Enter") e.preventDefault();
					menu.keys(e);
				}}
				onChange={(e) => {
					// Search filters the list only; clearing the pick here would silently
					// send the default model if the user closes without re-picking.
					setQuery(e.target.value);
				}}
			/>
			{query !== "" && (
				<span
					className="filter-note"
					role="status"
					title="Matching of total models"
				>
					{shown}/{total}
				</span>
			)}
			<div className="model-list">
				{loading ? (
					<Skeleton shape="list" rows={5} label="Loading the model list" />
				) : (
					rows.map((r) => (
						<Fragment key={r.key}>
							{r.divider && <hr className="model-divider" />}
							{r.heading && <div className="model-heading">{r.heading}</div>}
							<button
								type="button"
								className="model-option"
								aria-pressed={r.pressed}
								onClick={() => onPick(r.selector)}
								onKeyDown={menu.keys}
							>
								<span>{r.label}</span>
								{r.pressed && <Icon name="check" size={14} />}
							</button>
						</Fragment>
					))
				)}
			</div>
			{after}
		</div>
	);
}
