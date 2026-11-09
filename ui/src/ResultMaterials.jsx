import React, {useState} from "react";
import {Download, ExternalLink} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Accordion, AccordionItem, AccordionTrigger, AccordionContent} from "@/components/ui/accordion";
import {Tabs, TabsItem, TabsPanel} from "@/components/ui/tabs";
import KnowledgeGraph from "./KnowledgeGraph";
import CopyButton from "./CopyButton";

const instructions = [
  {key: "tutor", label: "Ведение занятия", hint: "Вопросы, подсказки и практика"},
  {key: "evaluator", label: "Оценка ответа", hint: "Проверка по материалу лекции"},
  {key: "feedback", label: "Обратная связь", hint: "Помощь после ответа слушателя"},
];
const contextMarker = "\n\nДанные курса\n";

function PromptReader({prompts, saveFile}) {
  const [selected, setSelected] = useState("tutor");
  const instruction = instructions.find(item => item.key === selected);
  const fullText = prompts[selected];
  const contextAt = fullText.indexOf(contextMarker);
  const instructionText = contextAt < 0 ? fullText : fullText.slice(0, contextAt);
  const context = contextAt < 0 ? null : fullText.slice(contextAt + contextMarker.length);
  // Formatting is for reading only. Downloads retain the exact compiled prompt.
  let formattedContext = context;
  if (context) {
    try { formattedContext = JSON.stringify(JSON.parse(context), null, 2); } catch { /* Show original text. */ }
  }

  return <>
    <p className="section-hint">Выберите, какую часть работы тьютора посмотреть. В каждой инструкции используются проверенные вами темы и определения.</p>
    <div className="prompt-choices" role="group" aria-label="Выбор инструкции">
      {instructions.map(item => <Button key={item.key} variant="secondary" active={selected === item.key}
        className="prompt-choice" aria-label={item.label} aria-pressed={selected === item.key}
        onClick={() => setSelected(item.key)}>
        <span className="prompt-choice-label">{item.label}<small>{item.hint}</small></span>
      </Button>)}
    </div>
    <article className="prompt-reader">
      <div className="prompt-reader-heading">
        <h3>{instruction.label}</h3>
        <div className="prompt-reader-actions">
          <CopyButton key={selected + "-text"} text={instructionText} label="Копировать текст" successLabel="Текст скопирован"/>
          <Button variant="ghost" leadingIcon={Download}
            onClick={() => saveFile(fullText, instruction.label + ".txt")}>Скачать промпт</Button>
        </div>
      </div>
      <div className="prompt-text" role="region" aria-label="Текст инструкции" tabIndex={0}>{instructionText}</div>
      {context && <details className="course-context" key={selected}>
        <summary>Данные курса в этом промпте</summary>
        <div className="course-context-heading">
          <p className="caption">Темы, словарь, связи и опорные фрагменты. В скачиваемом промпте они объединены с инструкцией.</p>
          <CopyButton key={selected + "-json"} text={formattedContext} label="Копировать JSON" successLabel="JSON скопирован"/>
        </div>
        <pre role="region" aria-label="Данные курса" tabIndex={0}>{formattedContext}</pre>
      </details>}
    </article>
  </>;
}

export default function ResultMaterials({pack, saveFile}) {
  const [tab, setTab] = useState(0);
  const [expanded, setExpanded] = useState("");

  return <section className="sheet details-section">
    <Accordion type="single" collapsible className="w-full" value={expanded} onValueChange={setExpanded}>
      <AccordionItem value="technical" highlight="trigger">
        <AccordionTrigger className="materials-trigger">Для подключения тьютора: граф, промпты и источники</AccordionTrigger>
        <AccordionContent>
          <Tabs selectedIndex={tab} onSelect={setTab} idPrefix="technical" aria-label="Материалы для подключения">
            <TabsItem index={0} label="Граф знаний"/>
            <TabsItem index={1} label="Промпты"/>
            <TabsItem index={2} label="Источники"/>
          </Tabs>
          <TabsPanel index={0} selectedIndex={tab} idPrefix="technical">
            <div className="materials-heading"><h3>Как связаны темы и термины</h3><span>Темы: {pack.topics.length} · Термины: {pack.terms.length}</span></div>
            <p className="section-hint">Нажмите на термин, чтобы увидеть определение и фрагменты лекции, на которые оно опирается.</p>
            {expanded === "technical" && <KnowledgeGraph pack={pack}/>}
          </TabsPanel>
          <TabsPanel index={1} selectedIndex={tab} idPrefix="technical"><PromptReader prompts={pack.prompts} saveFile={saveFile}/></TabsPanel>
          <TabsPanel index={2} selectedIndex={tab} idPrefix="technical">
            <h3>На чём основано занятие</h3>
            {pack.sources.length ? <ul className="source-list">{pack.sources.map(source => <li key={source.url}>
              <a href={source.url} target="_blank" rel="noreferrer">{source.name}<ExternalLink size={14} aria-hidden="true"/></a>
              {source.detail && <p>{source.detail}</p>}
            </li>)}</ul> : <p className="source-explanation">Источник — текст лекции, который вы добавили на первом шаге. Опорные фрагменты включены в файл занятия.</p>}
          </TabsPanel>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </section>;
}
