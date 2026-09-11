import { Link } from 'react-router-dom';
import { Code2, FileText, Plus, Table2, Workflow } from 'lucide-react';
import { MarketingFooter, MarketingHeader } from './MarketingShell';
import ProductDemo from './ProductDemo';
import UseCases from './UseCases';
import Pricing from './Pricing';
import { ExtractedFields } from './SampleDocument';
import { useAiAvailability } from '../../lib/ai';
import './marketing.css';

const workflowSteps = [
  { title: 'Capture', body: 'Upload a file or submit through the API.' },
  { title: 'Extract', body: 'Use a schema to find the fields that matter.' },
  { title: 'Review', body: 'Check values against the original.' },
  { title: 'Export', body: 'Download clean data or send a webhook.' },
];

const integrations = [
  { Icon: FileText, title: 'CSV, XLSX and JSON', body: 'Download structured results and line items.', label: 'Downloads' },
  { Icon: Code2, title: 'API and webhooks', body: 'Connect your systems with scoped keys and signed deliveries.', label: 'Developer tools' },
  { Icon: Workflow, title: 'Automation recipes', body: 'Guides for Zapier, Make, n8n and Power Automate.', label: 'Webhook bridges' },
  { Icon: Table2, title: 'Google Sheets', body: 'Requires a connected Google account and configuration.', label: 'Setup required' },
];

const faqs = [
  { question: 'What can I extract?', answer: 'Start with invoices, receipts, purchase orders, lead emails or a custom schema. Define the fields your workflow needs.' },
  { question: 'Can I check the results before exporting?', answer: 'Yes. Open a document to compare extracted fields with the original, correct values and approve a result. Missing values and validation issues stay visible during review.' },
  { question: 'How are pages counted?', answer: 'An accepted, unique upload uses its page count. PDFs are counted by page; an image or text document counts as one page. Automatic retries do not add usage. Choosing to reprocess a document counts its pages again. Your workspace shows its current allowance and usage.' },
  { question: 'Can I connect my existing tools?', answer: 'Download CSV, XLSX or JSON, or build a connection with the API and signed webhooks. The automation guides describe webhook bridges, not published native marketplace connectors. Google Sheets needs a configured Google connection.' },
  { question: 'What do I need for AI extraction?', answer: '', ai: true },
];

function Hero() {
  return (
    <section className="marketing-hero marketing-container" aria-labelledby="hero-title">
      <div className="marketing-hero-copy">
        <h1 id="hero-title"><span>Your documents.</span><span>Beautifully</span><span className="marketing-underlined">structured.</span></h1>
        <p className="marketing-handwritten">Less copying. More getting things done.</p>
        <p className="marketing-hero-description">Turn PDFs, emails and images into the fields you need. Review the details, then send clean data to your next step.</p>
        <div className="marketing-hero-actions">
          <Link className="button primary marketing-cta" to="/sign-up">Start extracting</Link>
          <Link className="button secondary marketing-cta" to="/sign-up?sample=invoice">Try a sample</Link>
        </div>
      </div>
      <div className="marketing-hero-media">
        <img className="marketing-hero-illustration" src="/assets/hero-document-tray.png" alt="Two documents becoming an organized set of information in a blue paper tray" width={1254} height={1254} fetchPriority="high" />
        <div className="marketing-hero-result">
          <h2>Extracted fields</h2>
          <ExtractedFields minimal />
          <p>Synthetic sample</p>
        </div>
      </div>
    </section>
  );
}

function WorkflowSection() {
  return (
    <section className="marketing-section marketing-workflow marketing-container" id="workflow" aria-labelledby="workflow-title">
      <div className="marketing-centered-heading">
        <h2 id="workflow-title">From a document to your next step.</h2>
        <p>A simple workflow, with you in control.</p>
      </div>
      <ol className="marketing-workflow-rail">
        {workflowSteps.map((step, index) => <li key={step.title}><span className="marketing-step-number">{index + 1}</span><h3>{step.title}</h3><p>{step.body}</p></li>)}
      </ol>
      <ProductDemo />
    </section>
  );
}

function IntegrationsSection() {
  return (
    <section className="marketing-section marketing-integrations marketing-container" id="integrations" aria-labelledby="integrations-title">
      <div className="marketing-integration-layout">
        <div className="marketing-integration-copy">
          <h2 id="integrations-title">Clean data.<br />Ready for what's next.</h2>
          <p>Download a file, call the API or send approved results to a webhook.</p>
          <Link className="button secondary marketing-cta" to="/help#integrations">Explore integrations</Link>
          <p className="marketing-handwritten">Keep your workflow moving.</p>
        </div>
        <div className="marketing-integration-list">
          {integrations.map(({ Icon, title, body, label }) => (
            <div className="marketing-integration-row" key={title}>
              <span className="marketing-integration-icon"><Icon size={30} strokeWidth={1.7} /></span>
              <div><h3>{title}</h3><p>{body}</p></div><span className="marketing-integration-label">{label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="marketing-integration-note"><h3>Clear connection status. No guesswork.</h3><p>Each integration shows its setup, delivery history and errors in your workspace.</p></div>
    </section>
  );
}

function FAQSection() {
  const ai = useAiAvailability();
  const aiAnswer = `${ai.message} AI mode sends document content to the configured provider. Text-anchor rules use readable text and do not read scans or images.`;
  return (
    <section className="marketing-section marketing-faq marketing-container" aria-labelledby="faq-title">
      <div className="marketing-faq-intro"><h2 id="faq-title">A few useful answers.</h2><p>Everything you need to get your first document moving.</p></div>
      <div className="marketing-faq-list">
        {faqs.map((faq, index) => <details className="marketing-faq-item" name="folio-faq" key={faq.question} open={index === 0}><summary><span>{faq.question}</span><Plus size={23} strokeWidth={1.7} aria-hidden="true" /></summary><p>{faq.ai ? aiAnswer : faq.answer}</p></details>)}
      </div>
    </section>
  );
}

export default function Landing() {
  return (
    <div className="marketing-page">
      <a className="marketing-skip-link" href="#main-content">Skip to content</a>
      <MarketingHeader />
      <main id="main-content">
        <Hero />
        <WorkflowSection />
        <UseCases />
        <IntegrationsSection />
        <Pricing />
        <FAQSection />
        <section className="marketing-final-cta marketing-container" aria-label="Try Folio"><h2>Let your documents do less waiting.</h2><Link className="button primary marketing-cta" to="/sign-up?sample=invoice">Try a sample</Link></section>
      </main>
      <MarketingFooter />
    </div>
  );
}
