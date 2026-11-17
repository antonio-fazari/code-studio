// Course registry. Lesson ids must be unique across all courses: they are the URL and the progress key.
import { lessons as foundationsLessons } from './backend-foundations/index.js';
import { renderCapstone as foundationsCapstone } from './backend-foundations/capstone.js';
import { lessons as systemDesignLessons } from './system-design/index.js';
import { renderCapstone as systemDesignCapstone } from './system-design/capstone.js';

export const courses = [
  {
    id: 'foundations',
    title: 'Backend Foundations',
    tagline: 'Twelve ideas every backend engineer needs, learned by growing one API from a single slow query to a production system.',
    intro: `<p>You will follow <strong>ShopLite</strong>, a small online shop with one API and one database. Each lesson opens with something going wrong in production, explains the concept that fixes it, and lets you try it in a simulation. The fix always exposes the next problem, so take the lessons in order.</p>`,
    lessons: foundationsLessons,
    capstoneId: 'capstone',
    renderCapstone: foundationsCapstone,
  },
  {
    id: 'system-design',
    title: 'System Design',
    tagline: 'Twenty concepts for systems that run on many machines, learned by taking ShopLite from one region to the whole world.',
    intro: `<p>Backend Foundations ended with ShopLite as a solid API in one data centre. In this course it grows into a global system: users on every continent, more data than one machine can hold, and dozens of services that fail independently. As before, each lesson starts from a problem the previous lesson left open.</p>
      <p>Seven topics appeared in Backend Foundations at the scale of one server. Here they come back at the scale of many, and each one links to the earlier lesson so you can refresh the basics first.</p>`,
    prerequisite: 'foundations',
    lessons: systemDesignLessons,
    capstoneId: 'sd-capstone',
    renderCapstone: systemDesignCapstone,
  },
];
