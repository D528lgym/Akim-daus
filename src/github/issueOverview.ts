/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { IComment } from '../common/comment';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { asPromise, formatError } from '../common/utils';
import { getNonce, IRequestMessage, WebviewBase } from '../common/webview';
import { DescriptionNode } from '../view/treeNodes/descriptionNode';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { ILabel } from './interface';
import { IssueModel } from './issueModel';
import { getLabelOptions } from './quickPicks';

export class IssueOverviewPanel<TItem extends IssueModel = IssueModel> extends WebviewBase {
	public static ID: string = 'IssueOverviewPanel';
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel?: IssueOverviewPanel;

	private static readonly _viewType: string = 'IssueOverview';

	protected readonly _panel: vscode.WebviewPanel;
	protected _descriptionNode: DescriptionNode;
	protected _item: TItem;
	protected _folderRepositoryManager: FolderRepositoryManager;
	protected _scrollPosition = { x: 0, y: 0 };

	public static async createOrShow(
		telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		folderRepositoryManager: FolderRepositoryManager,
		issue: IssueModel,
		toTheSide: Boolean = false,
	) {
		const activeColumn = toTheSide
			? vscode.ViewColumn.Beside
			: vscode.window.activeTextEditor
				? vscode.window.activeTextEditor.viewColumn
				: vscode.ViewColumn.One;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (IssueOverviewPanel.currentPanel) {
			IssueOverviewPanel.currentPanel._panel.reveal(activeColumn, true);
		} else {
			const title = `Issue #${issue.number.toString()}`;
			IssueOverviewPanel.currentPanel = new IssueOverviewPanel(
				telemetry,
				extensionUri,
				activeColumn || vscode.ViewColumn.Active,
				title,
				folderRepositoryManager,
			);
		}

		await IssueOverviewPanel.currentPanel!.update(folderRepositoryManager, issue);
	}

	public static refresh(): void {
		if (this.currentPanel) {
			this.currentPanel.refreshPanel();
		}
	}

	protected setPanelTitle(title: string): void {
		try {
			this._panel.title = title;
		} catch (e) {
			// The webview can be disposed at the time that we try to set the title if the user has closed
			// it while it's still loading.
		}
	}

	protected constructor(
		protected readonly _telemetry: ITelemetry,
		protected readonly _extensionUri: vscode.Uri,
		column: vscode.ViewColumn,
		title: string,
		folderRepositoryManager: FolderRepositoryManager,
		type: string = IssueOverviewPanel._viewType,
	) {
		super();
		this._folderRepositoryManager = folderRepositoryManager;

		// Create and show a new webview panel
		this._panel = this._register(vscode.window.createWebviewPanel(type, title, column, {
			// Enable javascript in the webview
			enableScripts: true,
			retainContextWhenHidden: true,

			// And restrict the webview to only loading content from our extension's `dist` directory.
			localResourceRoots: [vscode.Uri.joinPath(_extensionUri, 'dist')],
			enableFindWidget: true
		}));

		this._webview = this._panel.webview;
		super.initialize();

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programmatically
		this._register(this._panel.onDidDispose(() => this.dispose()));

		this._register(this._folderRepositoryManager.onDidChangeActiveIssue(
			_ => {
				if (this._folderRepositoryManager && this._item) {
					const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activeIssue);
					this._postMessage({
						command: 'pr.update-checkout-status',
						isCurrentlyCheckedOut: isCurrentlyCheckedOut,
					});
				}
			}));
	}

	public async refreshPanel(): Promise<void> {
		if (this._panel && this._panel.visible) {
			this.update(this._folderRepositoryManager, this._item);
		}
	}

	public async updateIssue(issueModel: IssueModel): Promise<void> {
		return Promise.all([
			this._folderRepositoryManager.resolveIssue(
				issueModel.remote.owner,
				issueModel.remote.repositoryName,
				issueModel.number,
			),
			issueModel.getIssueTimelineEvents(),
			this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(issueModel),
		])
			.then(result => {
				const [issue, timelineEvents, defaultBranch] = result;
				if (!issue) {
					throw new Error(
						`Fail to resolve issue #${issueModel.number} in ${issueModel.remote.owner}/${issueModel.remote.repositoryName}`,
					);
				}

				this._item = issue as TItem;
				this.setPanelTitle(`Issue #${issueModel.number.toString()}`);

				Logger.debug('pr.initialize', IssueOverviewPanel.ID);
				this._postMessage({
					command: 'pr.initialize',
					pullrequest: {
						number: this._item.number,
						title: this._item.title,
						titleHTML: this._item.titleHTML,
						url: this._item.html_url,
						createdAt: this._item.createdAt,
						body: this._item.body,
						bodyHTML: this._item.bodyHTML,
						labels: this._item.item.labels,
						author: {
							login: this._item.author.login,
							name: this._item.author.name,
							avatarUrl: this._item.userAvatar,
							url: this._item.author.url,
						},
						state: this._item.state,
						events: timelineEvents,
						repositoryDefaultBranch: defaultBranch,
						canEdit: true,
						// TODO@eamodio What is status?
						status: /*status ? status :*/ { statuses: [] },
						isIssue: true,
						isDarkTheme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
					},
				});
			})
			.catch(e => {
				vscode.window.showErrorMessage(`Error updating issue description: ${formatError(e)}`);
			});
	}

	public async update(foldersManager: FolderRepositoryManager, issueModel: IssueModel): Promise<void> {
		this._folderRepositoryManager = foldersManager;
		this._postMessage({
			command: 'set-scroll',
			scrollPosition: this._scrollPosition,
		});

		this._panel.webview.html = this.getHtmlForWebview();
		return this.updateIssue(issueModel);
	}

	protected override async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}

		switch (message.command) {
			case 'alert':
				vscode.window.showErrorMessage(message.args);
				return;
			case 'pr.close':
				return this.close(message);
			case 'pr.comment':
				return this.createComment(message);
			case 'scroll':
				this._scrollPosition = message.args.scrollPosition;
				return;
			case 'pr.edit-comment':
				return this.editComment(message);
			case 'pr.delete-comment':
				return this.deleteComment(message);
			case 'pr.edit-description':
				return this.editDescription(message);
			case 'pr.edit-title':
				return this.editTitle(message);
			case 'pr.refresh':
				this.refreshPanel();
				return;
			case 'pr.add-labels':
				return this.addLabels(message);
			case 'pr.remove-label':
				return this.removeLabel(message);
			case 'pr.debug':
				return this.webviewDebug(message);
			default:
				return this.MESSAGE_UNHANDLED;
		}
	}

	private async addLabels(message: IRequestMessage<void>): Promise<void> {
		const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
		try {
			let newLabels: ILabel[] = [];

			quickPick.busy = true;
			quickPick.canSelectMany = true;
			quickPick.show();
			quickPick.items = await (getLabelOptions(this._folderRepositoryManager, this._item.item.labels, this._item.remote.owner, this._item.remote.repositoryName).then(options => {
				newLabels = options.newLabels;
				return options.labelPicks;
			}));
			quickPick.selectedItems = quickPick.items.filter(item => item.picked);

			quickPick.busy = false;
			const acceptPromise = asPromise<void>(quickPick.onDidAccept).then(() => {
				return quickPick.selectedItems;
			});
			const hidePromise = asPromise<void>(quickPick.onDidHide);
			const labelsToAdd = await Promise.race<readonly vscode.QuickPickItem[] | void>([acceptPromise, hidePromise]);
			quickPick.busy = true;

			if (labelsToAdd) {
				await this._item.setLabels(labelsToAdd.map(r => r.label));
				const addedLabels: ILabel[] = labelsToAdd.map(label => newLabels.find(l => l.name === label.label)!);

				this._item.item.labels = addedLabels;

				await this._replyMessage(message, {
					added: addedLabels,
				});
			}
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		} finally {
			quickPick.hide();
			quickPick.dispose();
		}
	}

	private async removeLabel(message: IRequestMessage<string>): Promise<void> {
		try {
			await this._item.removeLabel(message.args);

			const index = this._item.item.labels.findIndex(label => label.name === message.args);
			this._item.item.labels.splice(index, 1);

			this._replyMessage(message, {});
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private webviewDebug(message: IRequestMessage<string>): void {
		Logger.debug(message.args, IssueOverviewPanel.ID);
	}

	private editDescription(message: IRequestMessage<{ text: string }>) {
		this._item
			.edit({ body: message.args.text })
			.then(result => {
				this._replyMessage(message, { body: result.body, bodyHTML: result.bodyHTML });
			})
			.catch(e => {
				this._throwError(message, e);
				vscode.window.showErrorMessage(`Editing description failed: ${formatError(e)}`);
			});
	}
	private editTitle(message: IRequestMessage<{ text: string }>) {
		return this._item
			.edit({ title: message.args.text })
			.then(result => {
				return this._replyMessage(message, { titleHTML: result.titleHTML });
			})
			.catch(e => {
				this._throwError(message, e);
				vscode.window.showErrorMessage(`Editing title failed: ${formatError(e)}`);
			});
	}

	protected editCommentPromise(comment: IComment, text: string): Promise<IComment> {
		return this._item.editIssueComment(comment, text);
	}

	private editComment(message: IRequestMessage<{ comment: IComment; text: string }>) {
		this.editCommentPromise(message.args.comment, message.args.text)
			.then(result => {
				this._replyMessage(message, {
					body: result.body,
					bodyHTML: result.bodyHTML,
				});
			})
			.catch(e => {
				this._throwError(message, e);
				vscode.window.showErrorMessage(formatError(e));
			});
	}

	protected deleteCommentPromise(comment: IComment): Promise<void> {
		return this._item.deleteIssueComment(comment.id.toString());
	}

	private deleteComment(message: IRequestMessage<IComment>) {
		vscode.window
			.showWarningMessage(vscode.l10n.t('Are you sure you want to delete this comment?'), { modal: true }, 'Delete')
			.then(value => {
				if (value === 'Delete') {
					this.deleteCommentPromise(message.args)
						.then(_ => {
							this._replyMessage(message, {});
						})
						.catch(e => {
							this._throwError(message, e);
							vscode.window.showErrorMessage(formatError(e));
						});
				}
			});
	}

	private close(message: IRequestMessage<string>) {
		vscode.commands
			.executeCommand<IComment>('pr.close', this._item, message.args)
			.then(comment => {
				if (comment) {
					this._replyMessage(message, {
						value: comment,
					});
				} else {
					this._throwError(message, 'Close cancelled');
				}
			});
	}

	private createComment(message: IRequestMessage<string>) {
		this._item.createIssueComment(message.args).then(comment => {
			this._replyMessage(message, {
				value: comment,
			});
		});
	}

	protected set _currentPanel(panel: IssueOverviewPanel | undefined) {
		IssueOverviewPanel.currentPanel = panel;
	}

	public override dispose() {
		super.dispose();
		this._currentPanel = undefined;
		this._webview = undefined;
	}

	protected getHtmlForWebview() {
		const nonce = getNonce();

		const uri = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-pr-description.js');

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; media-src https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">

		<meta name="viewport" content="width=device-width, initial-scale=1.0">
	</head>
	<body class="${process.platform}">
		<div id=app></div>
		<script nonce="${nonce}" src="${this._webview!.asWebviewUri(uri).toString()}"></script>
	</body>
</html>`;
	}

	public getCurrentTitle(): string {
		return this._panel.title;
	}
}
