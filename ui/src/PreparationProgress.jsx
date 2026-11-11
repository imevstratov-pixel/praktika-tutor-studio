import React, {useEffect, useState} from "react";
import {CheckCircle2, CircleDot, ClipboardCheck} from "lucide-react";
import {motion, useReducedMotion} from "motion/react";
import {Button} from "@/components/ui/button";
import {spring} from "@/lib/springs";

// The clock belongs to this small subtree. A tick never rerenders the form,
// reruns extraction, or persists the lesson to localStorage.
function ElapsedWait({startedAt, isAi, phase}) {
 const elapsedNow=()=>Math.max(0,Math.floor((Date.now()-startedAt)/1000));
 const [elapsed,setElapsed]=useState(elapsedNow);
 useEffect(()=>{
  const timer=setInterval(()=>setElapsed(elapsedNow()),1000);
  return()=>clearInterval(timer);
 },[startedAt]);
 const time=Math.floor(elapsed/60)+":"+String(elapsed%60).padStart(2,"0");
 const message=phase==="receiving"
  ?"Ответ поступает. Подготавливаем его для вашей проверки."
  :elapsed>=120
   ?"Ответ занимает больше времени. Можно подождать или отменить разбор и попробовать позже. Текст лекции сохранится."
   :elapsed>=30&&isAi
    ?"ИИ всё ещё готовит ответ. Продолжаем ждать — повторно отправлять текст не нужно."
    :"Можно отменить разбор — текст останется в черновике.";
 return <div className="preparation-wait">
  <p className="preparation-elapsed" aria-live="off">Прошло {time}</p>
  <p className="preparation-wait-message" role="status">{message}</p>
 </div>;
}

export default function PreparationProgress({headingRef,startedAt,isAi,phase,onCancel,hosted}) {
 const reducedMotion=useReducedMotion();
 return <div className="preparation-shell">
  <div className="page-heading">
   <h1 ref={headingRef} tabIndex={-1}>Готовим содержание занятия</h1>
   <p>{isAi?"Разбираем вашу лекцию, чтобы собрать черновик занятия.":"Собираем черновик занятия по тексту лекции."}</p>
  </div>
  <motion.section className="sheet preparation-panel" aria-label="Ход подготовки"
   initial={reducedMotion?false:{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={spring.moderate}>
   <ol className="preparation-steps">
    <li className="preparation-step">
     <CheckCircle2 className="preparation-step-icon" size={26} aria-hidden="true"/>
     <div><span className="preparation-step-state">Готово</span><h2>Текст лекции готов</h2><p>Название, текст и обязательные термины остаются в вашем черновике.</p></div>
    </li>
    <li className="preparation-step" aria-current="step">
     <CircleDot className="preparation-step-icon" size={26} aria-hidden="true"/>
     <div><span className="preparation-step-state">Сейчас</span><h2>{isAi?(phase==="receiving"?"Получаем результат разбора":"ИИ выделяет темы, термины и связи"):"Собираем темы и термины"}</h2><p>{phase==="receiving"?"Ответ начал поступать. Готовим его к показу.":isAi?"Ожидаем ответ по вашему тексту.":"Применяем локальные правила разбора текста."}</p></div>
    </li>
    <li className="preparation-step preparation-step-next">
     <ClipboardCheck className="preparation-step-icon" size={26} aria-hidden="true"/>
     <div><span className="preparation-step-state">После разбора</span><h2>Проверка содержания</h2><p>Вы проверите темы, определения и связи перед использованием.</p></div>
    </li>
   </ol>
   <ElapsedWait startedAt={startedAt} isAi={isAi} phase={phase}/>
   <div className="preparation-actions">
    <Button variant="secondary" onClick={onCancel}>Отменить разбор</Button>
    {hosted&&<p>Если ИИ уже начал обработку, запуск может остаться использованным.</p>}
   </div>
  </motion.section>
 </div>;
}
