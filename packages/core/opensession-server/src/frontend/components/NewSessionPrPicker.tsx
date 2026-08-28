import React, { useEffect, useState } from "react";
import { fetchOpenPrs, type OpenPr } from "../lib/api";
import { paletteIconBtn } from "../lib/palette-classes";
import { cn } from "../ui/cn";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { IconNewBranch, IconPullRequest } from "./icons";
import { RepoTile, repoLabel } from "./RepoTile";

interface Props {
	selected: OpenPr | null;
	disabled?: boolean;
	onSelect: (pullRequest: OpenPr) => void;
	onClear: () => void;
}

/**
 * The new-session composer's PR source picker. The parent owns the selected
 * start point; this component only owns the cached open-PR list and its menu.
 */
export function NewSessionPrPicker({
	selected,
	disabled,
	onSelect,
	onClear,
}: Props) {
	const [pullRequests, setPullRequests] = useState<OpenPr[] | null>(null);

	useEffect(() => {
		let live = true;
		fetchOpenPrs()
			.then((items) => {
				if (live) setPullRequests(items);
			})
			.catch(() => {
				if (live) setPullRequests([]);
			});
		return () => {
			live = false;
		};
	}, []);

	const ordered = [...(pullRequests || [])].sort((a, b) => {
		if (selected && a.repo === selected.repo && b.repo !== selected.repo) return -1;
		if (selected && b.repo === selected.repo && a.repo !== selected.repo) return 1;
		return b.updatedAt.localeCompare(a.updatedAt);
	});
	const label = selected ? `PR #${selected.number}` : "Start from a pull request";

	return (
		<Menu.Root>
			<Tooltip label={label}>
				<Menu.Trigger
					type="button"
					className={cn(
						selected
							? "inline-flex min-h-8 max-w-[130px] shrink-0 items-center gap-1.5 rounded-control bg-accent-soft px-2.5 text-label font-medium text-accent transition-[background,color] hover:bg-hover disabled:cursor-default disabled:opacity-50 phone:min-h-11 phone:max-w-[112px] phone:rounded-[999px] phone:px-3"
							: cn(
									paletteIconBtn,
									"shrink-0 phone:size-11 phone:rounded-[999px] phone:before:rounded-[999px]",
								),
					)}
					disabled={disabled}
					aria-label={label}
				>
					<IconPullRequest className="shrink-0" size={20} />
					{selected && <span className="truncate">#{selected.number}</span>}
				</Menu.Trigger>
			</Tooltip>
			<Menu.Popup
				align="start"
				sideOffset={6}
				className="w-[min(380px,calc(100vw-1rem))]"
			>
				<Menu.Group>
					<Menu.GroupLabel>Start from</Menu.GroupLabel>
					<Menu.Item onClick={onClear} className="phone:min-h-11">
						<IconNewBranch className="shrink-0 text-dim" size={20} />
						<span className="min-w-0 grow truncate">New branch</span>
						<Menu.Check on={!selected} className="text-dim" />
					</Menu.Item>
				</Menu.Group>
				<Menu.Separator />
				{pullRequests === null ? (
					<Menu.Item disabled className="phone:min-h-11 text-faint">
						Loading pull requests…
					</Menu.Item>
				) : ordered.length === 0 ? (
					<Menu.Item disabled className="phone:min-h-11 text-faint">
						No open pull requests
					</Menu.Item>
				) : (
					ordered.map((pullRequest) => {
						const active =
							selected?.repo === pullRequest.repo &&
							selected.number === pullRequest.number;
						return (
							<Menu.Item
								key={`${pullRequest.repo}:${pullRequest.number}`}
								onClick={() => onSelect(pullRequest)}
								className={cn(
									"items-start gap-2.5 py-2 phone:min-h-11",
									active && "bg-hover",
								)}
							>
								<RepoTile name={pullRequest.repo} size={20} />
								<span className="flex min-w-0 grow flex-col gap-0.5">
									<span className="truncate text-control-label text-fg">
										{repoLabel(pullRequest.repo)} #{pullRequest.number}
									</span>
									<span className="truncate text-supporting text-faint">
										{pullRequest.title}
									</span>
								</span>
								<Menu.Check on={active} className="mt-1 text-dim" />
							</Menu.Item>
						);
					})
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}
