class Trello implements WebToolIntegration {

    showIssueId = true;

    matchUrl = '*://trello.com/c/*';

    issueElementSelectorForCheck = [
        '[data-testid="card-back-copy-card-button"]',
        '[data-testid="check-item-name"]'
    ];

    issueElementSelector = () =>
        $$.all('[data-testid="check-item-name"]')
            .concat(
                $$.all('[data-testid="card-back-copy-card-button"]')
                    .map(element => element.parentElement?.parentElement)
                    .filter((parent): parent is HTMLElement => parent !== null) // Убираем null и явно указываем тип
            );



    render(issueElement: HTMLElement, linkElement: HTMLElement) {

        if ($$(this.issueElementSelectorForCheck[0], issueElement)) {
            // cut 'timer' so that time can be visible if we have time
            const text = linkElement.lastElementChild!.textContent;
            if (/[0-9]/.test(text!)) {
                linkElement.lastElementChild!.textContent = text!.replace(' timer', '');
            }

            const moveCardButton = $$('[data-testid="card-back-move-card-button"]', issueElement) || $$('[data-testid="card-back-copy-card-button"]', issueElement);

            if (moveCardButton) {
                const moveCardButtonLi = moveCardButton.closest('li');

                const buttonClasses = Array.from(moveCardButton.classList);

                buttonClasses.forEach(className => {
                    linkElement.classList.add(className);
                    linkElement.classList.add('devart-timer-link-trello');
                });

                const newLi = document.createElement('li');

                newLi.appendChild(linkElement);

                if (moveCardButtonLi && moveCardButtonLi.parentNode) {
                    moveCardButtonLi.parentNode.insertBefore(newLi, moveCardButtonLi);
                }
            }
        } else if (issueElement.matches(this.issueElementSelectorForCheck[1])) { // for checklist

            linkElement.classList.add('devart-timer-link-minimal', 'devart-timer-link-trello');

            let element = $$('[data-testid="check-item-set-due-button"]', issueElement);

            if (element) {
                element.parentElement!.insertBefore(linkElement, element);
            }
            else {
                element = $$('[data-testid="check-item-hover-buttons"]', issueElement);

                if (element) {
                    element.appendChild(linkElement);
                }
            }            
        }
    }

    getIssue(issueElement: HTMLElement, source: Source) {

        // Full card url:
        // https://trello.com/c/CARD_ID/CARD_NUMBER-CARD_TITLE_DASHED_AND_LOWERCASED
        // Effective card url:
        // https://trello.com/c/CARD_ID
        const match = /^\/c\/(.+)\/(\d+)-(.+)$/.exec(source.path);
        if (!match) {
            return;
        }

        // match[2] is a 'CARD_NUMBER' from path
        let issueId = match[2];
        if (!issueId) {
            return;
        }
        issueId = '#' + issueId;

        // <h2 class="window-title-text current hide-on-edit js-card-title">ISSUE_NAME</h2>
        const issueName = $$.try('#card-back-name').textContent;
        if (!issueName) {
            return;
        }

        const projectName = $$.try('.board-header h1[data-testid=board-name-display]').textContent;

        const serviceUrl = source.protocol + source.host;
        const serviceType = 'Trello';

        const issueUrl = '/c/' + match[1];

        const tagNames = $$.all('span[data-testid="card-label"]').map(label => label.textContent);

        let description: string | undefined | null;
        if (issueElement.matches(this.issueElementSelectorForCheck[1])) {
            description = issueElement.childNodes[0].textContent;
        }

        return {
            issueId, issueName, projectName, serviceType, serviceUrl, issueUrl, tagNames, description
        } as WebToolIssue;
    }
}

IntegrationService.register(new Trello());