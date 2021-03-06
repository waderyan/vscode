/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { TPromise } from 'vs/base/common/winjs.base';
import * as strings from 'vs/base/common/strings';
import { ICommonCodeEditor, IEditorContribution, IIdentifiedSingleEditOperation, ICommand, ICursorStateComputerData, IEditOperationBuilder, ITokenizedModel, EndOfLineSequence } from 'vs/editor/common/editorCommon';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { editorAction, ServicesAccessor, IActionOptions, EditorAction, commonEditorContribution } from 'vs/editor/common/editorCommonExtensions';
import { IQuickOpenService } from 'vs/platform/quickOpen/common/quickOpen';
import { IModelService } from 'vs/editor/common/services/modelService';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';
import { EditOperation } from 'vs/editor/common/core/editOperation';
import { TextModel } from 'vs/editor/common/model/textModel';
import { LanguageConfigurationRegistry } from 'vs/editor/common/modes/languageConfigurationRegistry';
import { ShiftCommand } from 'vs/editor/common/commands/shiftCommand';
import { TextEdit } from 'vs/editor/common/modes';
import * as IndentUtil from './indentUtils';

export function shiftIndent(tabSize: number, indentation: string, count?: number): string {
	count = count || 1;
	let desiredIndentCount = ShiftCommand.shiftIndentCount(indentation, indentation.length + count, tabSize);
	let newIndentation = '';
	for (let i = 0; i < desiredIndentCount; i++) {
		newIndentation += '\t';
	}

	return newIndentation;
}

export function unshiftIndent(tabSize: number, indentation: string, count?: number): string {
	count = count || 1;
	let desiredIndentCount = ShiftCommand.unshiftIndentCount(indentation, indentation.length + count, tabSize);
	let newIndentation = '';
	for (let i = 0; i < desiredIndentCount; i++) {
		newIndentation += '\t';
	}

	return newIndentation;
}

export function getReindentEditOperations(model: ITokenizedModel, startLineNumber: number, endLineNumber: number, inheritedIndent?: string): IIdentifiedSingleEditOperation[] {
	if (model.getLineCount() === 1 && model.getLineMaxColumn(1) === 1) {
		// Model is empty
		return undefined;
	}

	let indentationRules = LanguageConfigurationRegistry.getIndentationRules(model.getLanguageIdentifier().id);
	if (!indentationRules) {
		return undefined;
	}

	endLineNumber = Math.min(endLineNumber, model.getLineCount());

	// Skip `unIndentedLinePattern` lines
	while (startLineNumber <= endLineNumber) {
		if (!indentationRules.unIndentedLinePattern) {
			break;
		}

		let text = model.getLineContent(startLineNumber);
		if (!indentationRules.unIndentedLinePattern.test(text)) {
			break;
		}

		startLineNumber++;
	}

	if (startLineNumber > endLineNumber - 1) {
		return undefined;
	}

	let { tabSize, insertSpaces } = model.getOptions();
	let indentEdits = [];

	// indentation being passed to lines below
	let globalIndent: string;

	// Calculate indentation for the first line
	// If there is no passed-in indentation, we use the indentation of the first line as base.
	let currentLineText = model.getLineContent(startLineNumber);
	let adjustedLineContent = currentLineText;
	if (inheritedIndent !== undefined && inheritedIndent !== null) {
		globalIndent = inheritedIndent;
		let oldIndentation = strings.getLeadingWhitespace(currentLineText);

		adjustedLineContent = globalIndent + currentLineText.substring(oldIndentation.length);
		if (indentationRules.decreaseIndentPattern && indentationRules.decreaseIndentPattern.test(adjustedLineContent)) {
			globalIndent = unshiftIndent(tabSize, globalIndent);
			adjustedLineContent = globalIndent + currentLineText.substring(oldIndentation.length);

		}
		if (currentLineText !== adjustedLineContent) {
			indentEdits.push(EditOperation.replace(new Selection(startLineNumber, 1, startLineNumber, oldIndentation.length + 1), TextModel.normalizeIndentation(globalIndent, tabSize, insertSpaces)));
		}
	} else {
		globalIndent = strings.getLeadingWhitespace(currentLineText);
	}

	// idealIndentForNextLine doesn't equal globalIndent when there is a line matching `indentNextLinePattern`.
	let idealIndentForNextLine: string = globalIndent;

	if (indentationRules.increaseIndentPattern && indentationRules.increaseIndentPattern.test(adjustedLineContent)) {
		idealIndentForNextLine = shiftIndent(tabSize, idealIndentForNextLine);
		globalIndent = shiftIndent(tabSize, globalIndent);
	}
	else if (indentationRules.indentNextLinePattern && indentationRules.indentNextLinePattern.test(adjustedLineContent)) {
		idealIndentForNextLine = shiftIndent(tabSize, idealIndentForNextLine);
	}

	startLineNumber++;

	// Calculate indentation adjustment for all following lines
	for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber++) {
		let text = model.getLineContent(lineNumber);
		let oldIndentation = strings.getLeadingWhitespace(text);
		let adjustedLineContent = idealIndentForNextLine + text.substring(oldIndentation.length);

		if (indentationRules.decreaseIndentPattern && indentationRules.decreaseIndentPattern.test(adjustedLineContent)) {
			idealIndentForNextLine = unshiftIndent(tabSize, idealIndentForNextLine);
			globalIndent = unshiftIndent(tabSize, globalIndent);
		}

		if (oldIndentation !== idealIndentForNextLine) {
			indentEdits.push(EditOperation.replace(new Selection(lineNumber, 1, lineNumber, oldIndentation.length + 1), TextModel.normalizeIndentation(idealIndentForNextLine, tabSize, insertSpaces)));
		}

		// calculate idealIndentForNextLine
		if (indentationRules.unIndentedLinePattern && indentationRules.unIndentedLinePattern.test(text)) {
			// In reindent phase, if the line matches `unIndentedLinePattern` we inherit indentation from above lines
			// but don't change globalIndent and idealIndentForNextLine.
			continue;
		} else if (indentationRules.increaseIndentPattern && indentationRules.increaseIndentPattern.test(adjustedLineContent)) {
			globalIndent = shiftIndent(tabSize, globalIndent);
			idealIndentForNextLine = globalIndent;
		} else if (indentationRules.indentNextLinePattern && indentationRules.indentNextLinePattern.test(adjustedLineContent)) {
			idealIndentForNextLine = shiftIndent(tabSize, idealIndentForNextLine);
		} else {
			idealIndentForNextLine = globalIndent;
		}
	}

	return indentEdits;
}

@editorAction
export class IndentationToSpacesAction extends EditorAction {
	public static ID = 'editor.action.indentationToSpaces';

	constructor() {
		super({
			id: IndentationToSpacesAction.ID,
			label: nls.localize('indentationToSpaces', "Convert Indentation to Spaces"),
			alias: 'Convert Indentation to Spaces',
			precondition: EditorContextKeys.writable
		});
	}

	public run(accessor: ServicesAccessor, editor: ICommonCodeEditor): void {
		let model = editor.getModel();
		if (!model) {
			return;
		}
		let modelOpts = model.getOptions();
		const command = new IndentationToSpacesCommand(editor.getSelection(), modelOpts.tabSize);

		editor.pushUndoStop();
		editor.executeCommands(this.id, [command]);
		editor.pushUndoStop();

		model.updateOptions({
			insertSpaces: true
		});
	}
}

@editorAction
export class IndentationToTabsAction extends EditorAction {
	public static ID = 'editor.action.indentationToTabs';

	constructor() {
		super({
			id: IndentationToTabsAction.ID,
			label: nls.localize('indentationToTabs', "Convert Indentation to Tabs"),
			alias: 'Convert Indentation to Tabs',
			precondition: EditorContextKeys.writable
		});
	}

	public run(accessor: ServicesAccessor, editor: ICommonCodeEditor): void {
		let model = editor.getModel();
		if (!model) {
			return;
		}
		let modelOpts = model.getOptions();
		const command = new IndentationToTabsCommand(editor.getSelection(), modelOpts.tabSize);

		editor.pushUndoStop();
		editor.executeCommands(this.id, [command]);
		editor.pushUndoStop();

		model.updateOptions({
			insertSpaces: false
		});
	}
}

export class ChangeIndentationSizeAction extends EditorAction {

	constructor(private insertSpaces: boolean, opts: IActionOptions) {
		super(opts);
	}

	public run(accessor: ServicesAccessor, editor: ICommonCodeEditor): TPromise<void> {
		const quickOpenService = accessor.get(IQuickOpenService);
		const modelService = accessor.get(IModelService);

		let model = editor.getModel();
		if (!model) {
			return undefined;
		}

		let creationOpts = modelService.getCreationOptions(model.getLanguageIdentifier().language);
		const picks = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({
			id: n.toString(),
			label: n.toString(),
			// add description for tabSize value set in the configuration
			description: n === creationOpts.tabSize ? nls.localize('configuredTabSize', "Configured Tab Size") : null
		}));

		// auto focus the tabSize set for the current editor
		const autoFocusIndex = Math.min(model.getOptions().tabSize - 1, 7);

		return TPromise.timeout(50 /* quick open is sensitive to being opened so soon after another */).then(() =>
			quickOpenService.pick(picks, { placeHolder: nls.localize({ key: 'selectTabWidth', comment: ['Tab corresponds to the tab key'] }, "Select Tab Size for Current File"), autoFocus: { autoFocusIndex } }).then(pick => {
				if (pick) {
					model.updateOptions({
						tabSize: parseInt(pick.label, 10),
						insertSpaces: this.insertSpaces
					});
				}
			})
		);
	}
}

@editorAction
export class IndentUsingTabs extends ChangeIndentationSizeAction {

	public static ID = 'editor.action.indentUsingTabs';

	constructor() {
		super(false, {
			id: IndentUsingTabs.ID,
			label: nls.localize('indentUsingTabs', "Indent Using Tabs"),
			alias: 'Indent Using Tabs',
			precondition: null
		});
	}
}

@editorAction
export class IndentUsingSpaces extends ChangeIndentationSizeAction {

	public static ID = 'editor.action.indentUsingSpaces';

	constructor() {
		super(true, {
			id: IndentUsingSpaces.ID,
			label: nls.localize('indentUsingSpaces', "Indent Using Spaces"),
			alias: 'Indent Using Spaces',
			precondition: null
		});
	}
}

@editorAction
export class DetectIndentation extends EditorAction {

	public static ID = 'editor.action.detectIndentation';

	constructor() {
		super({
			id: DetectIndentation.ID,
			label: nls.localize('detectIndentation', "Detect Indentation from Content"),
			alias: 'Detect Indentation from Content',
			precondition: null
		});
	}

	public run(accessor: ServicesAccessor, editor: ICommonCodeEditor): void {
		const modelService = accessor.get(IModelService);

		let model = editor.getModel();
		if (!model) {
			return;
		}

		let creationOpts = modelService.getCreationOptions(model.getLanguageIdentifier().language);
		model.detectIndentation(creationOpts.insertSpaces, creationOpts.tabSize);
	}
}

@editorAction
export class ReindentLinesAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.reindentlines',
			label: nls.localize('editor.reindentlines', "Reindent Lines"),
			alias: 'Reindent Lines',
			precondition: EditorContextKeys.writable
		});
	}

	public run(accessor: ServicesAccessor, editor: ICommonCodeEditor): void {
		let model = editor.getModel();
		if (!model) {
			return;
		}
		let edits = getReindentEditOperations(model, 1, model.getLineCount());
		if (edits) {
			editor.executeEdits(this.id, edits);
		}
	}
}

export class AutoIndentOnPasteCommand implements ICommand {

	private _edits: TextEdit[];
	private _newEol: EndOfLineSequence;

	private _initialSelection: Selection;
	private _selectionId: string;

	constructor(edits: TextEdit[], initialSelection: Selection) {
		this._initialSelection = initialSelection;
		this._edits = [];
		this._newEol = undefined;

		for (let edit of edits) {
			if (typeof edit.eol === 'number') {
				this._newEol = edit.eol;
			}
			if (edit.range && typeof edit.text === 'string') {
				this._edits.push(edit);
			}
		}
	}

	public getEditOperations(model: ITokenizedModel, builder: IEditOperationBuilder): void {
		for (let edit of this._edits) {
			builder.addEditOperation(Range.lift(edit.range), edit.text);
		}

		var selectionIsSet = false;
		if (Array.isArray(this._edits) && this._edits.length === 1 && this._initialSelection.isEmpty()) {
			if (this._edits[0].range.startColumn === this._initialSelection.endColumn &&
				this._edits[0].range.startLineNumber === this._initialSelection.endLineNumber) {
				selectionIsSet = true;
				this._selectionId = builder.trackSelection(this._initialSelection, true);
			} else if (this._edits[0].range.endColumn === this._initialSelection.startColumn &&
				this._edits[0].range.endLineNumber === this._initialSelection.startLineNumber) {
				selectionIsSet = true;
				this._selectionId = builder.trackSelection(this._initialSelection, false);
			}
		}

		if (!selectionIsSet) {
			this._selectionId = builder.trackSelection(this._initialSelection);
		}
	}

	public computeCursorState(model: ITokenizedModel, helper: ICursorStateComputerData): Selection {
		return helper.getTrackedSelection(this._selectionId);
	}
}

@commonEditorContribution
export class AutoIndentOnPaste implements IEditorContribution {
	private static ID = 'editor.contrib.autoIndentOnPaste';

	private editor: ICommonCodeEditor;
	private callOnDispose: IDisposable[];
	private callOnModel: IDisposable[];

	constructor(editor: ICommonCodeEditor) {
		this.editor = editor;
		this.callOnDispose = [];
		this.callOnModel = [];

		this.callOnDispose.push(editor.onDidChangeConfiguration(() => this.update()));
		this.callOnDispose.push(editor.onDidChangeModel(() => this.update()));
		this.callOnDispose.push(editor.onDidChangeModelLanguage(() => this.update()));
	}

	private update(): void {

		// clean up
		this.callOnModel = dispose(this.callOnModel);

		// we are disabled
		if (!this.editor.getConfiguration().autoIndent || this.editor.getConfiguration().contribInfo.formatOnPaste) {
			return;
		}

		// no model
		if (!this.editor.getModel()) {
			return;
		}

		this.callOnModel.push(this.editor.onDidPaste((range: Range) => {
			this.trigger(range);
		}));
	}

	private trigger(range: Range): void {
		if (this.editor.getSelections().length > 1) {
			return;
		}

		const model = this.editor.getModel();
		const { tabSize, insertSpaces } = model.getOptions();
		this.editor.pushUndoStop();
		let textEdits: TextEdit[] = [];

		let indentConverter = {
			shiftIndent: (indentation) => {
				let desiredIndentCount = ShiftCommand.shiftIndentCount(indentation, indentation.length + 1, tabSize);
				let newIndentation = '';
				for (let i = 0; i < desiredIndentCount; i++) {
					newIndentation += '\t';
				}

				return newIndentation;
			},
			unshiftIndent: (indentation) => {
				let desiredIndentCount = ShiftCommand.unshiftIndentCount(indentation, indentation.length + 1, tabSize);
				let newIndentation = '';
				for (let i = 0; i < desiredIndentCount; i++) {
					newIndentation += '\t';
				}

				return newIndentation;
			}
		};
		let indentOfFirstLine = LanguageConfigurationRegistry.getGoodIndentForLine(model, model.getLanguageIdentifier().id, range.startLineNumber, indentConverter);

		if (indentOfFirstLine !== null) {
			let firstLineText = model.getLineContent(range.startLineNumber);
			let oldIndentation = strings.getLeadingWhitespace(firstLineText);
			let newSpaceCnt = IndentUtil.getSpaceCnt(indentOfFirstLine, tabSize);
			let oldSpaceCnt = IndentUtil.getSpaceCnt(oldIndentation, tabSize);

			if (newSpaceCnt !== oldSpaceCnt) {
				let newIndent = IndentUtil.generateIndent(newSpaceCnt, tabSize, insertSpaces);
				textEdits.push({
					range: new Range(range.startLineNumber, 1, range.startLineNumber, oldIndentation.length + 1),
					text: newIndent
				});
				firstLineText = newIndent + firstLineText.substr(oldIndentation.length);
			}

			if (range.startLineNumber !== range.endLineNumber) {
				let virtualModel = {
					getLineTokens: (lineNumber: number) => {
						return model.getLineTokens(lineNumber);
					},
					getLanguageIdentifier: () => {
						return model.getLanguageIdentifier();
					},
					getLanguageIdAtPosition: (lineNumber: number, column: number) => {
						return model.getLanguageIdAtPosition(lineNumber, column);
					},
					getLineContent: (lineNumber) => {
						if (lineNumber === range.startLineNumber) {
							return firstLineText;
						} else {
							return model.getLineContent(lineNumber);
						}
					}
				};
				let indentOfSecondLine = LanguageConfigurationRegistry.getGoodIndentForLine(virtualModel, model.getLanguageIdentifier().id, range.startLineNumber + 1, indentConverter);
				let newSpaceCntOfSecondLine = IndentUtil.getSpaceCnt(indentOfSecondLine, tabSize);
				let oldSpaceCntOfSecondLine = IndentUtil.getSpaceCnt(strings.getLeadingWhitespace(model.getLineContent(range.startLineNumber + 1)), tabSize);

				if (newSpaceCntOfSecondLine !== oldSpaceCntOfSecondLine) {
					let spaceCntOffset = newSpaceCntOfSecondLine - oldSpaceCntOfSecondLine;
					for (let i = range.startLineNumber + 1; i <= range.endLineNumber; i++) {
						let lineContent = model.getLineContent(i);
						let originalIndent = strings.getLeadingWhitespace(lineContent);
						let originalSpacesCnt = IndentUtil.getSpaceCnt(originalIndent, tabSize);
						let newSpacesCnt = originalSpacesCnt + spaceCntOffset;
						let newIndent = IndentUtil.generateIndent(newSpacesCnt, tabSize, insertSpaces);

						if (newIndent !== originalIndent) {
							textEdits.push({
								range: new Range(i, 1, i, originalIndent.length + 1),
								text: newIndent
							});
						}
					}
				}
			}
		}

		let cmd = new AutoIndentOnPasteCommand(textEdits, this.editor.getSelection());
		this.editor.executeCommand('autoIndentOnPaste', cmd);
		this.editor.pushUndoStop();
	}

	public getId(): string {
		return AutoIndentOnPaste.ID;
	}

	public dispose(): void {
		this.callOnDispose = dispose(this.callOnDispose);
		this.callOnModel = dispose(this.callOnModel);
	}
}

function getIndentationEditOperations(model: ITokenizedModel, builder: IEditOperationBuilder, tabSize: number, tabsToSpaces: boolean): void {
	if (model.getLineCount() === 1 && model.getLineMaxColumn(1) === 1) {
		// Model is empty
		return;
	}

	let spaces = '';
	for (let i = 0; i < tabSize; i++) {
		spaces += ' ';
	}

	const content = model.getLinesContent();
	for (let i = 0; i < content.length; i++) {
		let lastIndentationColumn = model.getLineFirstNonWhitespaceColumn(i + 1);
		if (lastIndentationColumn === 0) {
			lastIndentationColumn = model.getLineMaxColumn(i + 1);
		}

		const text = (tabsToSpaces ? content[i].substr(0, lastIndentationColumn).replace(/\t/ig, spaces) :
			content[i].substr(0, lastIndentationColumn).replace(new RegExp(spaces, 'gi'), '\t')) +
			content[i].substr(lastIndentationColumn);

		builder.addEditOperation(new Range(i + 1, 1, i + 1, model.getLineMaxColumn(i + 1)), text);
	}
}

export class IndentationToSpacesCommand implements ICommand {

	private selectionId: string;

	constructor(private selection: Selection, private tabSize: number) { }

	public getEditOperations(model: ITokenizedModel, builder: IEditOperationBuilder): void {
		this.selectionId = builder.trackSelection(this.selection);
		getIndentationEditOperations(model, builder, this.tabSize, true);
	}

	public computeCursorState(model: ITokenizedModel, helper: ICursorStateComputerData): Selection {
		return helper.getTrackedSelection(this.selectionId);
	}
}

export class IndentationToTabsCommand implements ICommand {

	private selectionId: string;

	constructor(private selection: Selection, private tabSize: number) { }

	public getEditOperations(model: ITokenizedModel, builder: IEditOperationBuilder): void {
		this.selectionId = builder.trackSelection(this.selection);
		getIndentationEditOperations(model, builder, this.tabSize, false);
	}

	public computeCursorState(model: ITokenizedModel, helper: ICursorStateComputerData): Selection {
		return helper.getTrackedSelection(this.selectionId);
	}
}
