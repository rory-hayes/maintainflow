import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck } from 'lucide-react';
import { PLANS } from '../../../shared/plans';

function boundedNumber(value: string, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(0, parsed)) : 0;
}

function SavingsCalculator() {
  const id = useId();
  const [documents, setDocuments] = useState(500);
  const [minutes, setMinutes] = useState(3);
  const hours = (documents * minutes) / 60;
  return (
    <div className="marketing-calculator" aria-labelledby="calculator-title">
      <div className="marketing-calculator-inputs">
        <h3 id="calculator-title">What could you save?</h3>
        <p>An illustrative calculator, using your assumptions.</p>
        <div className="marketing-calculator-controls">
          <div>
            <label htmlFor={`${id}-documents`}>Documents per month</label>
            <input id={`${id}-documents`} type="number" min={0} max={20000} step={1} value={documents} onChange={(event) => setDocuments(Math.round(boundedNumber(event.target.value, 20000)))} />
            <input aria-label="Adjust documents per month" type="range" min={0} max={20000} step={100} value={documents} onChange={(event) => setDocuments(Number(event.target.value))} />
          </div>
          <div>
            <label htmlFor={`${id}-minutes`}>Minutes per document</label>
            <input id={`${id}-minutes`} type="number" min={0} max={30} step={0.5} value={minutes} onChange={(event) => setMinutes(boundedNumber(event.target.value, 30))} />
            <input aria-label="Adjust minutes per document" type="range" min={0} max={30} step={0.5} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} />
          </div>
        </div>
      </div>
      <div className="marketing-calculator-output">
        <output aria-live="polite" aria-atomic="true" htmlFor={`${id}-documents ${id}-minutes`}>{new Intl.NumberFormat('en-IE', { maximumFractionDigits: 1 }).format(hours)} <span>{hours === 1 ? 'hour' : 'hours'}</span></output>
        <p>of manual entry per month</p>
        <small>Before review time. This is an estimate, not a promised result.</small>
      </div>
    </div>
  );
}

export default function Pricing() {
  return (
    <section className="marketing-section marketing-pricing marketing-container" id="pricing" aria-labelledby="pricing-title">
      <div className="marketing-centered-heading">
        <h2 id="pricing-title">Start small. Make room for more.</h2>
        <p>Choose the allowance that fits your documents.</p>
      </div>
      <div className="marketing-pricing-columns">
        {PLANS.map((plan) => (
          <article className="marketing-price-column" key={plan.id} aria-labelledby={`plan-${plan.id}`}>
            <h3 id={`plan-${plan.id}`}>{plan.name}</h3>
            <p className="marketing-price"><strong>€{plan.monthlyPrice}</strong><span>/ month</span></p>
            <p className="marketing-plan-pages">{plan.monthlyPages.toLocaleString('en-IE')} pages / month</p>
            <ul>{plan.features.map((feature) => <li key={feature}><CircleCheck size={21} strokeWidth={1.7} /><span>{feature}</span></li>)}</ul>
            <Link className="button primary marketing-cta" to={`/sign-up?plan=${plan.id}`}>Get started</Link>
          </article>
        ))}
      </div>
      <p className="marketing-pricing-note">Illustrative launch pricing. Checkout availability is shown in your workspace.</p>
      <SavingsCalculator />
    </section>
  );
}
